// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation
#if canImport(Darwin)
import Darwin
#endif

public enum ProxySteering {
    public static let steeredPort = 443

    public enum Pass: String, Equatable, Sendable {
        case notTCP, notHTTPS, noHost, noCatalogue, notCatalogued, ownAgent, excludedApp
        case unknownAddress
    }

    public enum Verdict: Equatable, Sendable {
        case steer(serviceId: String)
        case steerByAddress(serviceId: String, host: String)
        case passThrough(Pass)

        public var steers: Bool {
            switch self {
            case .steer, .steerByAddress: return true
            case .passThrough: return false
            }
        }
    }

    public static func decide(isTCP: Bool, host: String?, port: Int?, catalogue: GuardCatalogue?, ownAgent: @autoclosure () -> Bool,
                              excludedApp: @autoclosure () -> Bool = false,
                              hostForAddress: (String) -> String? = { _ in nil }) -> Verdict {
        guard isTCP else { return .passThrough(.notTCP) }
        if let port, port != steeredPort { return .passThrough(.notHTTPS) }
        let address = host.flatMap(HostAddressCache.canonical)
        guard let host, address != nil || !HostMatcher.normalise(host).isEmpty else { return .passThrough(.noHost) }
        guard let catalogue else { return .passThrough(.noCatalogue) }
        var name = host
        var byAddress = false
        if let address {
            guard AddressSteering.isSteerable(address), let learned = hostForAddress(address) else { return .passThrough(.unknownAddress) }
            name = learned
            byAddress = true
        }
        guard let service = HostMatcher.serviceForHost(catalogue, host: name) else { return .passThrough(.notCatalogued) }
        if ownAgent() { return .passThrough(.ownAgent) }
        if excludedApp() { return .passThrough(.excludedApp) }
        return byAddress ? .steerByAddress(serviceId: service.serviceId, host: HostMatcher.normalise(name)) : .steer(serviceId: service.serviceId)
    }
}

public enum AddressSteering {
    public static let maxRules = 512
    public static let reapplyEvery: TimeInterval = 1

    public static func isSteerable(_ address: String) -> Bool {
        guard let canonical = HostAddressCache.canonical(address) else { return false }
        if !canonical.contains(":") {
            let o = canonical.split(separator: ".").compactMap { Int($0) }
            guard o.count == 4 else { return false }
            switch (o[0], o[1]) {
            case (0, _), (10, _), (127, _), (169, 254), (192, 168), (255, _): return false
            case (172, 16...31): return false
            case (100, 64...127): return false
            case (224...239, _): return false
            default: return true
            }
        }
        if canonical == "::" || canonical == "::1" { return false }
        if canonical.hasPrefix("::ffff:") { return isSteerable(String(canonical.dropFirst(7))) }
        let first = canonical.split(separator: ":", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        guard let head = UInt16(first, radix: 16) else { return false }
        if head & 0xfe00 == 0xfc00 { return false }
        if head & 0xffc0 == 0xfe80 { return false }
        if head & 0xff00 == 0xff00 { return false }
        return true
    }

    public static func addresses(_ entries: [(address: String, host: String)], catalogue: GuardCatalogue?) -> [String] {
        guard let catalogue else { return [] }
        var out = Set<String>()
        for entry in entries where isSteerable(entry.address) && HostMatcher.isIntercepted(catalogue, host: entry.host) {
            if let canonical = HostAddressCache.canonical(entry.address) { out.insert(canonical) }
        }
        return Array(out.sorted().prefix(maxRules))
    }
}

public enum DNSAnswer {
    public struct Parsed: Equatable, Sendable {
        public var name: String
        public var addresses: [String]
        public var ttl: Int
    }

    public static func parse(_ data: Data) -> Parsed? {
        let b = [UInt8](data)
        guard b.count >= 12 else { return nil }
        let flags = Int(b[2]) << 8 | Int(b[3])
        guard flags & 0x8000 != 0, flags & 0x000f == 0 else { return nil }
        let qd = Int(b[4]) << 8 | Int(b[5])
        let an = Int(b[6]) << 8 | Int(b[7])
        guard qd >= 1 else { return nil }
        var p = 12
        var question: String?
        for _ in 0..<qd {
            guard let (name, next) = readName(b, p) else { return nil }
            if question == nil { question = name }
            p = next + 4
            guard p <= b.count else { return nil }
        }
        guard let name = question, !name.isEmpty else { return nil }
        var addresses: [String] = []
        var ttl = Int.max
        for _ in 0..<an {
            guard let (_, next) = readName(b, p) else { break }
            p = next
            guard p + 10 <= b.count else { break }
            let type = Int(b[p]) << 8 | Int(b[p + 1])
            let recordTTL = Int(b[p + 4]) << 24 | Int(b[p + 5]) << 16 | Int(b[p + 6]) << 8 | Int(b[p + 7])
            let length = Int(b[p + 8]) << 8 | Int(b[p + 9])
            p += 10
            guard p + length <= b.count else { break }
            if type == 1, length == 4 {
                addresses.append("\(b[p]).\(b[p + 1]).\(b[p + 2]).\(b[p + 3])")
                ttl = min(ttl, recordTTL)
            } else if type == 28, length == 16 {
                var groups: [String] = []
                for i in stride(from: 0, to: 16, by: 2) { groups.append(String(Int(b[p + i]) << 8 | Int(b[p + i + 1]), radix: 16)) }
                if let canonical = HostAddressCache.canonical(groups.joined(separator: ":")) { addresses.append(canonical) }
                ttl = min(ttl, recordTTL)
            }
            p += length
        }
        return Parsed(name: HostMatcher.normalise(name), addresses: addresses, ttl: ttl == Int.max ? 0 : ttl)
    }

    private static func readName(_ b: [UInt8], _ start: Int) -> (String, Int)? {
        var labels: [String] = []
        var p = start
        var end: Int?
        var jumps = 0
        while true {
            guard p < b.count else { return nil }
            let len = Int(b[p])
            if len == 0 { p += 1; break }
            if len & 0xc0 == 0xc0 {
                guard p + 1 < b.count, jumps < 16 else { return nil }
                if end == nil { end = p + 2 }
                p = (len & 0x3f) << 8 | Int(b[p + 1])
                jumps += 1
                continue
            }
            guard len & 0xc0 == 0, p + 1 + len <= b.count else { return nil }
            labels.append(String(decoding: b[(p + 1)..<(p + 1 + len)], as: UTF8.self))
            p += 1 + len
            guard labels.count <= 127 else { return nil }
        }
        return (labels.joined(separator: "."), end ?? p)
    }
}

public struct AgentHealth: Equatable, Sendable {
    public enum State: String, Equatable, Sendable { case unknown, up, down }

    public static let connectDeadline: TimeInterval = 2
    public static let probeDeadline: TimeInterval = 0.75
    public static let probeEvery: TimeInterval = 2
    public static let missesToDown = 2

    public private(set) var state: State = .unknown
    public private(set) var since: Date
    public private(set) var failuresInARow = 0

    public init(now: Date = Date()) { since = now }

    public var usable: Bool { state == .up }

    public var nextProbeIn: TimeInterval { Self.probeEvery }

    @discardableResult
    public mutating func reached(at now: Date = Date()) -> Bool {
        failuresInARow = 0
        guard state != .up else { return false }
        state = .up
        since = now
        return true
    }

    @discardableResult
    public mutating func missed(at now: Date = Date()) -> Bool {
        failuresInARow += 1
        guard failuresInARow >= Self.missesToDown, state != .down else { return false }
        state = .down
        since = now
        return true
    }
}

public enum AgentProbe {
    public static let line = Data("PROXY UNKNOWN vibtra-health\r\n".utf8)
    public static let answer = Data("VIBTRA-GUARD OK\r\n".utf8)

    public static func verdict(_ received: Data) -> Bool? {
        if received.count >= answer.count { return received.prefix(answer.count) == answer }
        return answer.starts(with: received) ? nil : false
    }
}

public struct ReplayBuffer: Equatable, Sendable {
    public static let defaultCapacity = 64 * 1024

    public let capacity: Int
    public private(set) var bytes = Data()
    public private(set) var sawEnd = false
    public private(set) var overflowed = false

    public init(capacity: Int = ReplayBuffer.defaultCapacity) { self.capacity = capacity }

    public var replayable: Bool { !overflowed }

    public mutating func append(_ data: Data) {
        guard !overflowed else { return }
        if bytes.count + data.count > capacity {
            overflowed = true
            bytes = Data()
        } else {
            bytes.append(data)
        }
    }

    public mutating func end() { sawEnd = true }

    public mutating func release() { bytes = Data() }
}

public struct FlowRelayPlan: Equatable, Sendable {
    public enum Phase: String, Equatable, Sendable { case toAgent, awaitingAnswer, viaAgent, toDestination, direct, closed }
    public enum Event: String, Equatable, Sendable { case ready, waiting, failed, deadline, unreplayable }
    public enum Answer: Equatable, Sendable {
        case firstBytes
        case silent(replayable: Bool)
        case closedEarly(replayable: Bool)
    }
    public enum Action: Equatable, Sendable {
        case openFlowViaAgent
        case agentAnswered
        case fallBackDirect
        case openFlowDirect
        case closeFlow
        case ignore
    }

    public static let answerDeadline: TimeInterval = 3
    public static let directDeadline: TimeInterval = 15

    public private(set) var phase: Phase = .toAgent
    public init() {}

    public mutating func agent(_ event: Event) -> Action {
        guard phase == .toAgent else { return .ignore }
        switch event {
        case .ready:
            phase = .awaitingAnswer
            return .openFlowViaAgent
        case .unreplayable:
            return .ignore
        case .waiting, .failed, .deadline:
            phase = .toDestination
            return .fallBackDirect
        }
    }

    public mutating func agentAnswer(_ answer: Answer) -> Action {
        guard phase == .awaitingAnswer else { return .ignore }
        switch answer {
        case .firstBytes:
            phase = .viaAgent
            return .agentAnswered
        case .silent(let replayable), .closedEarly(let replayable):
            if replayable {
                phase = .toDestination
                return .fallBackDirect
            }
            phase = .closed
            return .closeFlow
        }
    }

    public mutating func direct(_ event: Event) -> Action {
        guard phase == .toDestination else { return .ignore }
        switch event {
        case .ready:
            phase = .direct
            return .openFlowDirect
        case .waiting:
            return .ignore
        case .failed, .deadline, .unreplayable:
            phase = .closed
            return .closeFlow
        }
    }

    public mutating func closed() { phase = .closed }
}

public final class HostAddressCache: @unchecked Sendable {
    public static let defaultTTL: TimeInterval = 600
    private let lock = NSLock()
    private var entries: [String: (host: String, expires: Date)] = [:]
    private let capacity: Int

    public init(capacity: Int = 4096) { self.capacity = capacity }

    public static func canonical(_ address: String) -> String? {
        var text = address
        if text.hasPrefix("[") && text.hasSuffix("]") { text = String(text.dropFirst().dropLast()) }
        if let percent = text.firstIndex(of: "%") { text = String(text[..<percent]) }
        var v4 = in_addr()
        if inet_pton(AF_INET, text, &v4) == 1 {
            var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            guard inet_ntop(AF_INET, &v4, &buf, socklen_t(buf.count)) != nil else { return nil }
            return String(cString: buf)
        }
        var v6 = in6_addr()
        if inet_pton(AF_INET6, text, &v6) == 1 {
            var buf = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
            guard inet_ntop(AF_INET6, &v6, &buf, socklen_t(buf.count)) != nil else { return nil }
            return String(cString: buf).lowercased()
        }
        return nil
    }

    public var onNewAddress: (() -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return newAddressObserver }
        set { lock.lock(); newAddressObserver = newValue; lock.unlock() }
    }
    private var newAddressObserver: (() -> Void)?

    public func record(address: String, host: String, ttl: TimeInterval = HostAddressCache.defaultTTL, now: Date = Date()) {
        guard let key = Self.canonical(address) else { return }
        let h = HostMatcher.normalise(host)
        guard !h.isEmpty else { return }
        lock.lock()
        let isNew = entries[key].map { $0.host != h || $0.expires <= now } ?? true
        let observer = isNew ? newAddressObserver : nil
        defer { observer?() }
        defer { lock.unlock() }
        entries[key] = (h, now.addingTimeInterval(ttl))
        if entries.count > capacity {
            entries = entries.filter { $0.value.expires > now }
            while entries.count > capacity, let oldest = entries.min(by: { $0.value.expires < $1.value.expires })?.key {
                entries.removeValue(forKey: oldest)
            }
        }
    }

    public func host(for address: String, now: Date = Date()) -> String? {
        guard let key = Self.canonical(address) else { return nil }
        lock.lock(); defer { lock.unlock() }
        guard let entry = entries[key] else { return nil }
        if entry.expires <= now { entries.removeValue(forKey: key); return nil }
        return entry.host
    }

    public var count: Int { lock.lock(); defer { lock.unlock() }; return entries.count }

    public func snapshot(now: Date = Date()) -> [(address: String, host: String)] {
        lock.lock(); defer { lock.unlock() }
        return entries.filter { $0.value.expires > now }.map { (address: $0.key, host: $0.value.host) }
    }

    public func purge(keeping keep: (String) -> Bool) {
        lock.lock(); defer { lock.unlock() }
        entries = entries.filter { keep($0.value.host) }
    }
}

public enum CatalogueResolution {
    public static let refreshEvery: TimeInterval = 300

    public static func hosts(_ catalogue: GuardCatalogue) -> [String] {
        var out = Set<String>()
        for service in catalogue.services where service.enabled {
            for pattern in service.domains where !pattern.contains("*") {
                out.insert(pattern)
                if pattern.split(separator: ".").count == 2 { out.insert("www.\(pattern)") }
            }
        }
        return out.sorted()
    }
}
