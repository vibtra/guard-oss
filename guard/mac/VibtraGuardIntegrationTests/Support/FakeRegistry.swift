// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation

final class FakeRegistry: @unchecked Sendable {
    let authority: PolicyAuthority
    let enrolToken = "genr_" + PolicyAuthority.hex(bytes: 16)
    let http: HTTPStub
    private let lock = NSLock()
    private var policyValue: GuardPolicy
    private var pair: (bundle: JSONValue, catalogue: JSONValue)
    private var offering = true
    private var servedSinceOffer = false
    private var revoked = false
    private var uploadedEvents: [[String: Any]] = []
    private var enrolRequests: [[String: Any]] = []

    init(policy: GuardPolicy) throws {
        let authority = PolicyAuthority()
        self.authority = authority
        policyValue = policy
        pair = try authority.signedPair(policy)
        http = try HTTPStub()
        http.handler = { [weak self] request in self?.reply(request) ?? .text(503, "registry stopped") }
    }

    var baseURL: String { http.baseURL }
    var policy: GuardPolicy { lock.withLock { policyValue } }
    var bundleEnvelope: JSONValue { lock.withLock { pair.bundle } }
    var catalogueEnvelope: JSONValue { lock.withLock { pair.catalogue } }
    var uploads: [[String: Any]] { lock.withLock { uploadedEvents } }
    var enrolments: [[String: Any]] { lock.withLock { enrolRequests } }

    func publish(_ policy: GuardPolicy, bundle: Bool = true, catalogue: Bool = true) throws {
        let next = try authority.signedPair(policy)
        lock.withLock {
            policyValue = policy
            pair = (bundle ? next.bundle : .null, catalogue ? next.catalogue : .null)
            offering = true
            servedSinceOffer = false
        }
    }

    func revoke() { lock.withLock { revoked = true } }

    func stop() { http.stop() }

    private func reply(_ request: HTTPMessage) -> HTTPReply {
        let prefix = "/api/guard/v1"
        guard request.path.hasPrefix(prefix) else { return .text(404, "not a registry route") }
        let route = String(request.path.dropFirst(prefix.count))
        if route == "/enrol" { return enrol(request) }
        guard request.headers["authorization"] == "Bearer \(authority.deviceToken)" else {
            return .json(401, .object(["code": .string("GUARD_DEVICE_TOKEN_INVALID")]))
        }
        let device = "/" + authority.deviceId
        switch route {
        case "/preflight" + device: return preflight()
        case "/ruledownload" + device: return download()
        case "/eventupload" + device: return upload(request)
        case "/postflight" + device: return postflight(request)
        case "/requests" + device: return .json(200, .object(["requests": .array([])]))
        default: return .json(404, .object(["code": .string("NOT_FOUND")]))
        }
    }

    private func enrol(_ request: HTTPMessage) -> HTTPReply {
        let body = request.json() ?? [:]
        lock.withLock { enrolRequests.append(body) }
        guard body["enrolToken"] as? String == enrolToken else {
            return .json(400, .object(["code": .string("GUARD_ENROL_TOKEN_INVALID")]))
        }
        return .json(200, authority.enrolment(clientMode: policy.clientMode))
    }

    private func preflight() -> HTTPReply {
        lock.lock()
        defer { lock.unlock() }
        if revoked { return .json(403, .object(["code": .string("GUARD_DEVICE_REVOKED")])) }
        return .json(200, .object([
            "clientMode": .string(policyValue.clientMode),
            "syncIntervalSeconds": .int(10),
            "batchSize": .int(100),
            "cleanSync": .bool(false),
            "rulesChanged": .bool(offering),
            "catalogueChanged": .bool(offering),
            "signingKeyId": .string(authority.keyId),
        ]))
    }

    private func download() -> HTTPReply {
        lock.lock()
        defer { lock.unlock() }
        servedSinceOffer = true
        return .json(200, .object(["bundle": pair.bundle, "catalogue": pair.catalogue]))
    }

    private func postflight(_ request: HTTPMessage) -> HTTPReply {
        let active = request.json()?["bundleVersion"] as? Int
        lock.withLock {
            if servedSinceOffer, active == policyValue.bundleVersion { offering = false }
        }
        return .json(200, .object(["nextSyncInSeconds": .int(10)]))
    }

    private func upload(_ request: HTTPMessage) -> HTTPReply {
        let events = request.json()?["events"] as? [[String: Any]] ?? []
        lock.withLock { uploadedEvents.append(contentsOf: events) }
        return .json(200, .object(["accepted": .int(events.count), "rejected": .array([])]))
    }
}
