// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation
import NetworkExtension
import os

final class FilterDataProvider: NEFilterDataProvider {
    private let log = Logger(subsystem: GuardConstants.extensionBundleId, category: "filter")
    private var configObservation: NSKeyValueObservation?

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        let state = ExtensionState.shared
        state.loadFromContainer()
        state.load(fromConfiguration: filterConfiguration.vendorConfiguration, source: "filter configuration")
        configObservation = observe(\.filterConfiguration, options: [.new]) { provider, _ in
            ExtensionState.shared.load(fromConfiguration: provider.filterConfiguration.vendorConfiguration, source: "filter configuration (changed)")
        }
        let outboundTCP = NENetworkRule(remoteNetwork: nil, remotePrefix: 0, localNetwork: nil, localPrefix: 0, protocol: .TCP, direction: .outbound)
        let outboundUDP = NENetworkRule(remoteNetwork: nil, remotePrefix: 0, localNetwork: nil, localPrefix: 0, protocol: .UDP, direction: .outbound)
        let settings = NEFilterSettings(rules: [NEFilterRule(networkRule: outboundTCP, action: .filterData),
                                                NEFilterRule(networkRule: outboundUDP, action: .filterData)], defaultAction: .allow)
        state.startResolving()
        apply(settings) { [log] error in
            if let error { log.error("applying filter settings failed: \(error.localizedDescription, privacy: .public)") }
            completionHandler(error)
        }
    }

    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        configObservation = nil
        completionHandler()
    }

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        guard let socket = flow as? NEFilterSocketFlow else { return .allow() }
        let state = ExtensionState.shared
        let (bundle, catalogue) = state.snapshot()
        let (address, port) = Self.remote(socket)
        let auditToken = flow.sourceAppAuditToken
        if SigningIdentity.isExcludedCodex(signingId: SigningIdentity.identifier(auditToken: auditToken), auditToken: auditToken, catalogue: catalogue) {
            return .allow()
        }
        if socket.socketProtocol == IPPROTO_UDP {
            if port == 53 {
                return .filterDataVerdict(withFilterInbound: true, peekInboundBytes: DNSPeek.bytes, filterOutbound: false, peekOutboundBytes: 0)
            }
            let verdict = FlowVerdict.decideDatagram(host: socket.remoteHostname, remoteAddress: address, port: port, catalogue: catalogue) { state.addresses.host(for: $0) }
            if case let .dropQUIC(serviceId) = verdict {
                log.notice("dropped QUIC to \(address ?? "?", privacy: .public) (\(serviceId, privacy: .public)): the browser falls back to TCP")
                return .drop()
            }
            return .allow()
        }
        guard let host = socket.remoteHostname else { return .allow() }
        if let catalogue, let address, HostMatcher.isIntercepted(catalogue, host: host) {
            state.addresses.record(address: address, host: host)
        }
        switch FlowVerdict.decide(host: host, signingId: SigningIdentity.identifier(auditToken: auditToken), bundle: bundle, catalogue: catalogue,
                                  isOwnAgent: { SigningIdentity.isOwnAgent(signingId: $0, auditToken: auditToken) }) {
        case .allow, .dropQUIC:
            return .allow()
        case let .drop(decision, serviceId, signingId):
            state.record(ExtensionEvents.flowEvent(decision: decision, serviceId: serviceId, host: host, port: port, signingId: signingId, bundleVersion: bundle?.bundleVersion))
            return .drop()
        }
    }

    override func handleInboundData(from flow: NEFilterFlow, readBytesStartOffset offset: Int, readBytes: Data) -> NEFilterDataVerdict {
        let state = ExtensionState.shared
        if let catalogue = state.snapshot().1, let answer = DNSAnswer.parse(readBytes), !answer.addresses.isEmpty,
           HostMatcher.isIntercepted(catalogue, host: answer.name) {
            let ttl = max(HostAddressCache.defaultTTL, TimeInterval(answer.ttl))
            for address in answer.addresses { state.addresses.record(address: address, host: answer.name, ttl: ttl) }
            log.info("learnt \(answer.addresses.count) addresses of \(answer.name, privacy: .public) from a DNS answer")
        }
        return .allow()
    }

    override func handleOutboundData(from flow: NEFilterFlow, readBytesStartOffset offset: Int, readBytes: Data) -> NEFilterDataVerdict { .allow() }
    override func handleInboundDataComplete(for flow: NEFilterFlow) -> NEFilterDataVerdict { .allow() }
    override func handleOutboundDataComplete(for flow: NEFilterFlow) -> NEFilterDataVerdict { .allow() }

    private enum DNSPeek {
        static let bytes = 1500
    }

    private static func remote(_ socket: NEFilterSocketFlow) -> (String?, Int?) {
        if #available(macOS 15.0, *) {
            guard let endpoint = socket.remoteFlowEndpoint else { return (nil, nil) }
            return EndpointParts.of(endpoint)
        }
        guard let endpoint = socket.remoteEndpoint as? NWHostEndpoint else { return (nil, nil) }
        return (endpoint.hostname, Int(endpoint.port))
    }

}
