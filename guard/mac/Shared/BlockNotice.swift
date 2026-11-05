// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation

public struct BlockNoticeGate {
    public static let quietGap: TimeInterval = 10
    private var lastSeen: [String: Date] = [:]

    public init() {}

    public static func key(_ d: DecisionEvent) -> String {
        [d.action, d.serviceId ?? "", d.ruleId ?? "", d.reason ?? "", d.appName ?? ""].joined(separator: "|")
    }

    public mutating func admit(_ d: DecisionEvent, now: Date = Date()) -> Bool {
        guard d.needsNotice else { return false }
        let key = Self.key(d)
        lastSeen = lastSeen.filter { now.timeIntervalSince($0.value) < Self.quietGap }
        let fresh = lastSeen[key] == nil
        lastSeen[key] = now
        return fresh
    }
}

public struct BlockNotice: Equatable {
    public var identifier: String
    public var title: String
    public var body: String
    public var eventId: String

    public init(_ d: DecisionEvent) {
        eventId = d.eventId
        identifier = "guard-block-" + String(BlockNoticeGate.key(d).hashValue, radix: 16)
        let service = d.serviceName ?? "an AI service"
        if d.action == "asked" {
            title = "Approval needed"
            body = "Vibtra Guard held a request to \(service) until it is approved. Click to see why and to ask for access."
        } else {
            title = "Request blocked"
            let rule = d.ruleName.map { " by the rule \"\($0)\"" } ?? ""
            body = "Vibtra Guard blocked a request to \(service)\(rule). Click to see why and what to do next."
        }
    }
}
