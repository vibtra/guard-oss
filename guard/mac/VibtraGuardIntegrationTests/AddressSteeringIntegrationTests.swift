// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import XCTest

final class AddressSteeringIntegrationTests: GuardIntegrationCase {
    private enum Record { case a([UInt8]), aaaa([UInt8]), cname(String) }

    private static func dnsResponse(question: String, answers: [Record], flags: UInt16 = 0x8180, ttl: UInt32 = 300) -> Data {
        func name(_ n: String) -> [UInt8] {
            var out: [UInt8] = []
            for label in n.split(separator: ".") { out.append(UInt8(label.utf8.count)); out += Array(label.utf8) }
            return out + [0]
        }
        var b: [UInt8] = [0x12, 0x34, UInt8(flags >> 8), UInt8(flags & 0xff), 0, 1, 0, UInt8(answers.count), 0, 0, 0, 0]
        b += name(question) + [0, 1, 0, 1]
        for record in answers {
            b += [0xc0, 0x0c]
            let (type, data): (UInt16, [UInt8]) = {
                switch record {
                case let .a(bytes): return (1, bytes)
                case let .aaaa(bytes): return (28, bytes)
                case let .cname(target): return (5, name(target))
                }
            }()
            b += [UInt8(type >> 8), UInt8(type & 0xff), 0, 1]
            b += [UInt8(ttl >> 24), UInt8((ttl >> 16) & 0xff), UInt8((ttl >> 8) & 0xff), UInt8(ttl & 0xff)]
            b += [UInt8(data.count >> 8), UInt8(data.count & 0xff)] + data
        }
        return Data(b)
    }

    private static let v6Bytes: [UInt8] = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x07]

    private func learn(_ data: Data, into cache: HostAddressCache) {
        guard let answer = DNSAnswer.parse(data) else { return }
        for address in answer.addresses { cache.record(address: address, host: answer.name, ttl: TimeInterval(answer.ttl)) }
    }

    func testAnAddressLearntFromDNSIsSteeredToTheAgentWhichDecidesBySNI() throws {
        let fixture = try makeFixture()
        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let cache = HostAddressCache()
        let signals = Counter()
        cache.onNewAddress = { signals.increment() }

        let response = Self.dnsResponse(question: "ChatGPT.com", answers: [.cname("chatgpt.com.cdn.example.net"), .a([203, 0, 113, 7]), .aaaa(Self.v6Bytes)], ttl: 120)
        let answer = try XCTUnwrap(DNSAnswer.parse(response))
        XCTAssertEqual(answer.name, "chatgpt.com", "filed under the question's name, through the CNAME")
        XCTAssertEqual(answer.addresses, ["203.0.113.7", "2001:db8::7"])
        XCTAssertEqual(answer.ttl, 120)
        learn(response, into: cache)
        XCTAssertEqual(signals.value, 2, "each new address asks the provider to re-apply its rules")
        cache.record(address: "203.0.113.7", host: "chatgpt.com")
        XCTAssertEqual(signals.value, 2, "a refresh of a known address is not news")
        XCTAssertEqual(AddressSteering.addresses(cache.snapshot(), catalogue: catalogue), ["2001:db8::7", "203.0.113.7"])
        XCTAssertEqual(FlowVerdict.decideDatagram(host: nil, remoteAddress: "203.0.113.7", port: 443, catalogue: catalogue) { cache.host(for: $0) },
                       .dropQUIC(serviceId: "openai-chatgpt"), "QUIC to the learnt address is dropped so the browser falls back to TCP")

        let front = try fixture.front(SteeringRoute(host: "203.0.113.7"), catalogue: catalogue, addresses: cache)
        let v4 = try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/by-address"))
        XCTAssertEqual(front.verdicts.last, .steerByAddress(serviceId: "openai-chatgpt", host: "chatgpt.com"))
        XCTAssertEqual(front.preambles.last.map { String(decoding: $0, as: UTF8.self) }, "PROXY TCP4 127.0.0.1 203.0.113.7 0 443\r\n")
        XCTAssertEqual(v4.status, 200)
        XCTAssertEqual(v4.peerSubject, "chatgpt.com")
        XCTAssertEqual(v4.text, GuardFixture.upstreamBody)

        front.route = SteeringRoute(host: "[2001:DB8:0:0:0:0:0:7]")
        let v6 = try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/by-address-v6"))
        XCTAssertEqual(front.verdicts.last, .steerByAddress(serviceId: "openai-chatgpt", host: "chatgpt.com"),
                       "bracketed, upper-case, uncompressed IPv6 is the same address")
        XCTAssertEqual(front.preambles.last.map { String(decoding: $0, as: UTF8.self) }.map { $0.hasPrefix("PROXY TCP6 ") }, true)
        XCTAssertEqual(v6.status, 200)

        cache.record(address: "203.0.113.8", host: "claude.ai")
        front.route = SteeringRoute(host: "203.0.113.8")
        let shared = try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/shared-address"))
        XCTAssertEqual(front.verdicts.last, .steerByAddress(serviceId: "anthropic-claude", host: "claude.ai"),
                       "the extension only knows the address was last seen for claude.ai")
        XCTAssertEqual(shared.peerSubject, "chatgpt.com", "the agent decides by the TLS SNI, not by the address")
        XCTAssertEqual(shared.status, 200)
        let newest = try XCTUnwrap(fixture.agent.waitForActivity { $0.count >= 3 }?.first)
        XCTAssertEqual(newest["serviceId"] as? String, "openai-chatgpt")
        XCTAssertEqual(front.onQueue { front.relays.allSatisfy { !$0.wentDirect } }, true)
    }

    func testEverySpellingOfAnAddressIsOneEntryAndTheCacheStaysBounded() throws {
        let fixture = try makeFixture()
        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let cache = HostAddressCache(capacity: 3)
        cache.record(address: "2001:DB8:0:0::7%en0", host: "ChatGPT.com.")
        cache.record(address: "not an address", host: "claude.ai")
        cache.record(address: "claude.ai", host: "claude.ai")
        XCTAssertEqual(cache.count, 1, "a name or garbage is never filed as an address")
        XCTAssertEqual(cache.host(for: "2001:db8::7"), "chatgpt.com")
        XCTAssertNil(cache.host(for: "chatgpt.com"))
        XCTAssertEqual(HostAddressCache.canonical("::FFFF:203.0.113.7"), "::ffff:203.0.113.7")
        XCTAssertEqual(HostAddressCache.canonical("203.0.113.7"), "203.0.113.7")

        let front = try fixture.front(SteeringRoute(host: "2001:db8::7"), catalogue: catalogue, addresses: cache)
        let scoped = try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/scoped-address"))
        XCTAssertEqual(front.verdicts.last, .steerByAddress(serviceId: "openai-chatgpt", host: "chatgpt.com"),
                       "an address learnt with a zone index and upper-case hex steers the plain spelling")
        XCTAssertEqual(scoped.status, 200)
        XCTAssertEqual(scoped.peerSubject, "chatgpt.com")

        for index in 1...4 { cache.record(address: "192.0.2.\(index)", host: "claude.ai", ttl: 60 * Double(index)) }
        XCTAssertEqual(cache.count, 3, "bounded at its capacity")
        XCTAssertEqual(cache.host(for: "192.0.2.4"), "claude.ai", "the newest survives")
        XCTAssertNil(cache.host(for: "192.0.2.1"), "the soonest to expire goes first")
        XCTAssertNil(cache.host(for: "192.0.2.2"))
        XCTAssertEqual(cache.host(for: "2001:db8::7"), "chatgpt.com")
    }

    func testAddressesNoEnabledHostWasSeenAtAreHandedBack() throws {
        let fixture = try makeFixture()
        let catalogue = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let cache = HostAddressCache()
        let local = ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.20.0.1", "169.254.1.1", "100.64.0.1", "::1", "fe80::1", "fd00::5", "0.0.0.0", "224.0.0.251"]
        for address in local { cache.record(address: address, host: "chatgpt.com") }
        cache.record(address: "203.0.113.7", host: "chatgpt.com")
        cache.record(address: "203.0.113.9", host: "chatgpt.com", ttl: -1)
        cache.record(address: "198.51.100.20", host: "www.example.org")
        for malformed in [
            Self.dnsResponse(question: "chatgpt.com", answers: [.a([203, 0, 113, 30])], flags: 0x0100),
            Self.dnsResponse(question: "chatgpt.com", answers: [], flags: 0x8183),
            Data([0x12, 0x34, 0x81]),
            Data(),
        ] {
            XCTAssertNil(DNSAnswer.parse(malformed))
            learn(malformed, into: cache)
        }
        let full = Self.dnsResponse(question: "chatgpt.com", answers: [.a([203, 0, 113, 31])])
        XCTAssertEqual(DNSAnswer.parse(full.prefix(full.count - 3))?.addresses, [], "a truncated record is not read past the end")
        var loop = [UInt8](Self.dnsResponse(question: "chatgpt.com", answers: []))
        loop.replaceSubrange(12..<(loop.count - 4), with: [0xc0, 0x0c])
        XCTAssertNil(DNSAnswer.parse(Data(loop)), "a compression pointer loop ends, as nil")

        XCTAssertEqual(AddressSteering.addresses(cache.snapshot(), catalogue: catalogue), ["203.0.113.7"],
                       "rules name only public addresses of enabled AI hosts")
        XCTAssertEqual(AddressSteering.addresses(cache.snapshot(), catalogue: nil), [])
        let many = (0..<(AddressSteering.maxRules + 50)).map { (address: "104.16.\($0 / 256).\($0 % 256)", host: "chatgpt.com") }
        XCTAssertEqual(AddressSteering.addresses(many, catalogue: catalogue).count, AddressSteering.maxRules)
        for address in local { XCTAssertFalse(AddressSteering.isSteerable(address), address) }
        for address in ["203.0.113.7", "8.8.8.8", "172.32.0.1", "2001:db8::7", "2606:4700::1"] { XCTAssertTrue(AddressSteering.isSteerable(address), address) }

        let front = try fixture.front(SteeringRoute(host: "198.51.100.9"), catalogue: catalogue, addresses: cache)
        let routes: [(SteeringRoute, ProxySteering.Verdict)] = local.map { (SteeringRoute(host: $0), .passThrough(.unknownAddress)) } + [
            (SteeringRoute(host: "198.51.100.9"), .passThrough(.unknownAddress)),
            (SteeringRoute(host: "203.0.113.9"), .passThrough(.unknownAddress)),
            (SteeringRoute(host: "203.0.113.30"), .passThrough(.unknownAddress)),
            (SteeringRoute(host: "::ffff:203.0.113.7"), .passThrough(.unknownAddress)),
            (SteeringRoute(host: "198.51.100.20"), .passThrough(.notCatalogued)),
            (SteeringRoute(host: "203.0.113.7", port: 80), .passThrough(.notHTTPS)),
            (SteeringRoute(host: "203.0.113.7", ownAgent: true), .passThrough(.ownAgent)),
        ]
        for (route, expected) in routes {
            front.route = route
            XCTAssertThrowsError(try fixture.send(front, serverName: "chatgpt.com", request(host: "chatgpt.com", path: "/not-steered")), route.host)
            XCTAssertEqual(front.verdicts.last, expected, route.host)
        }
        XCTAssertEqual(FlowVerdict.decideDatagram(host: "chatgpt.com", remoteAddress: nil, port: 53, catalogue: catalogue) { cache.host(for: $0) },
                       .allow(.notQUIC), "DNS is never dropped")
        XCTAssertEqual(FlowVerdict.decideDatagram(host: nil, remoteAddress: "203.0.113.7", port: 3478, catalogue: catalogue) { cache.host(for: $0) },
                       .allow(.notQUIC))
        XCTAssertEqual(FlowVerdict.decideDatagram(host: nil, remoteAddress: "198.51.100.9", port: 443, catalogue: catalogue) { cache.host(for: $0) },
                       .allow(.notCatalogued), "an address nobody named is never guessed")
        XCTAssertEqual(FlowVerdict.decideDatagram(host: "chatgpt.com", remoteAddress: nil, port: 443, catalogue: nil) { cache.host(for: $0) },
                       .allow(.noCatalogue))
        XCTAssertTrue(front.relays.isEmpty)
        XCTAssertTrue(try fixture.agent.activity().isEmpty, "none of these flows reached the agent")
    }

    func testSwitchingARowOffStopsSteeringItsAddresses() throws {
        let fixture = try makeFixture()
        let before = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let cache = HostAddressCache()
        cache.record(address: "203.0.113.8", host: "claude.ai")
        cache.record(address: "203.0.113.7", host: "chatgpt.com")
        XCTAssertEqual(ProxySteering.decide(isTCP: true, host: "203.0.113.8", port: 443, catalogue: before, ownAgent: false, hostForAddress: { cache.host(for: $0) }),
                       .steerByAddress(serviceId: "anthropic-claude", host: "claude.ai"))
        XCTAssertTrue(CatalogueResolution.hosts(before).contains("claude.ai"))

        var policy = GuardPolicy()
        policy.bundleVersion = 2
        policy.catalogueVersion = "2026-10-17+example.2"
        policy.disabledServices = ["anthropic-claude", "anthropic-api"]
        try fixture.registry.publish(policy)
        try fixture.waitForPolicy(2)
        let after = try XCTUnwrap(fixture.extensionDocuments().catalogue)
        let front = try fixture.front(SteeringRoute(host: "203.0.113.8"), catalogue: after, addresses: cache)
        XCTAssertThrowsError(try fixture.send(front, serverName: "claude.ai", request(host: "claude.ai", path: "/stale-address")))
        XCTAssertEqual(front.verdicts.last, .passThrough(.notCatalogued), "a stale address of a row switched off is not steered even before it is purged")
        cache.purge { HostMatcher.isIntercepted(after, host: $0) }
        XCTAssertNil(cache.host(for: "203.0.113.8"))
        XCTAssertEqual(cache.host(for: "203.0.113.7"), "chatgpt.com")
        XCTAssertEqual(AddressSteering.addresses(cache.snapshot(), catalogue: after), ["203.0.113.7"])
        XCTAssertFalse(CatalogueResolution.hosts(after).contains("claude.ai"))
        let resolution = CatalogueResolution.hosts(after)
        XCTAssertTrue(resolution.contains("chatgpt.com"))
        XCTAssertTrue(resolution.contains("www.perplexity.ai"), "www. in front of a two-label host")
        XCTAssertFalse(resolution.contains("www.gemini.google.com"))
        XCTAssertFalse(resolution.contains { $0.contains("*") })
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}
