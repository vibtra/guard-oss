// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import Network
import Security

struct TLSExchange {
    let response: HTTPMessage
    let peerSubject: String?

    var status: Int { response.status }
    var text: String { response.text }
    func header(_ name: String) -> String? { response.headers[name.lowercased()] }
    func json() -> [String: Any]? { response.json() }
}

enum TLSClient {
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var buffer = Data()
        var subject: String?
        var trusted = false
        var failure: String?
        var finished = false
    }

    static func exchange(port: UInt16, serverName: String, anchor: SecCertificate, request: Data,
                         timeout: TimeInterval = 20) throws -> TLSExchange {
        let queue = DispatchQueue(label: "app.vibtra.guard.integration.tls-client")
        let state = State()
        let done = DispatchSemaphore(value: 0)
        let tls = NWProtocolTLS.Options()
        let options = tls.securityProtocolOptions
        sec_protocol_options_set_tls_server_name(options, serverName)
        sec_protocol_options_add_tls_application_protocol(options, "http/1.1")
        sec_protocol_options_set_verify_block(options, { _, trustRef, complete in
            let trust = sec_trust_copy_ref(trustRef).takeRetainedValue()
            SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, serverName as CFString))
            SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
            SecTrustSetAnchorCertificatesOnly(trust, true)
            var error: CFError?
            let ok = SecTrustEvaluateWithError(trust, &error)
            let chain = (SecTrustCopyCertificateChain(trust) as? [SecCertificate]) ?? []
            state.lock.withLock {
                state.trusted = ok
                state.subject = chain.first.flatMap { SecCertificateCopySubjectSummary($0) as String? }
            }
            complete(ok)
        }, queue)
        let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: NWParameters(tls: tls, tcp: NWProtocolTCP.Options()))
        let finish: (String?) -> Void = { failure in
            let first = state.lock.withLock { () -> Bool in
                guard !state.finished else { return false }
                state.finished = true
                state.failure = failure
                return true
            }
            if first { done.signal() }
        }
        func read() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, isComplete, error in
                if let data { state.lock.withLock { state.buffer.append(data) } }
                if isComplete || error != nil {
                    finish(nil)
                    return
                }
                read()
            }
        }
        connection.stateUpdateHandler = { update in
            switch update {
            case .ready:
                connection.send(content: request, completion: .contentProcessed { error in
                    if let error { finish("send failed: \(error)") }
                })
                read()
            case let .failed(error):
                finish("connection failed: \(error)")
            case let .waiting(error):
                finish("connection waiting: \(error)")
            default:
                break
            }
        }
        connection.start(queue: queue)
        let waited = done.wait(timeout: .now() + timeout)
        connection.cancel()
        let (buffer, subject, trusted, failure) = state.lock.withLock { (state.buffer, state.subject, state.trusted, state.failure) }
        if waited == .timedOut { throw IntegrationError("no TLS answer for \(serverName) in \(Int(timeout)) s (received \(buffer.count) bytes)") }
        guard trusted else { throw IntegrationError("the certificate for \(serverName) does not chain to the agent's CA (\(failure ?? "no failure"), subject \(subject ?? "none"))") }
        guard let response = HTTPWire.parse(buffer, complete: true) else {
            throw IntegrationError("no HTTP response for \(serverName): \(failure ?? "connection closed") after \(buffer.count) bytes")
        }
        return TLSExchange(response: response, peerSubject: subject)
    }
}
