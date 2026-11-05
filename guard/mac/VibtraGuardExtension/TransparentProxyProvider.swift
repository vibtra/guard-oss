// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation
import Network
import NetworkExtension
import os

final class TransparentProxyProvider: NETransparentProxyProvider {
    private let log = Logger(subsystem: GuardConstants.extensionBundleId, category: "proxy")
    private let queue = DispatchQueue(label: GuardConstants.extensionBundleId + ".proxy")
    private let attributionSigner = NativeRelaySigner()
    private let attributionDiagnostics = NativeRelayDiagnostics(component: "flow")
    private lazy var monitor = AgentMonitor(queue: queue, log: log)
    private var relays: [ObjectIdentifier: FlowRelay] = [:]
    private var appliedHosts: [String]?
    private var appliedAddresses: [String]?
    private var reapplyPending = false
    private var lastApply = Date.distantPast

    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)? = nil) {
        attributionSigner.receiveMessage(messageData, completionHandler: completionHandler)
    }

    override func startProxy(options: [String: Any]? = nil, completionHandler: @escaping (Error?) -> Void) {
        let state = ExtensionState.shared
        state.addresses.onNewAddress = { [weak self] in self?.addressesChanged() }
        state.loadFromContainer()
        state.load(fromConfiguration: (protocolConfiguration as? NETunnelProviderProtocol)?.providerConfiguration, source: "proxy configuration")
        state.startResolving()
        state.onCatalogueChange { [weak self] catalogue in
            guard let self else { return }
            self.queue.async { self.applyRules(catalogue, completion: nil) }
        }
        let retireDirectConnections: () -> Void = { [weak self] in
            guard let self else { return }
            for relay in Array(self.relays.values) { relay.closeDirectOnRecovery() }
        }
        monitor.onRecovery = retireDirectConnections
        monitor.onProbeSuccess = retireDirectConnections
        monitor.start()
        queue.async { [self] in applyRules(state.snapshot().1, completion: completionHandler) }
    }

    private func addressesChanged() {
        queue.async { [self] in
            guard !reapplyPending else { return }
            reapplyPending = true
            let wait = max(0, AddressSteering.reapplyEvery - Date().timeIntervalSince(lastApply))
            queue.asyncAfter(deadline: .now() + wait) { [self] in
                reapplyPending = false
                applyRules(ExtensionState.shared.snapshot().1, completion: nil)
            }
        }
    }

    private func applyRules(_ catalogue: GuardCatalogue?, completion: ((Error?) -> Void)?) {
        let hosts = catalogue.map(SteeringRules.steeredHosts) ?? []
        let addresses = AddressSteering.addresses(ExtensionState.shared.addresses.snapshot(), catalogue: catalogue)
        if completion == nil, hosts == appliedHosts, addresses == appliedAddresses { return }
        appliedHosts = hosts
        appliedAddresses = addresses
        lastApply = Date()
        let settings = NETransparentProxyNetworkSettings(tunnelRemoteAddress: "127.0.0.1")
        settings.includedNetworkRules = hosts.map(Self.rule(forHost:)) + addresses.map(Self.rule(forAddress:))
        log.notice("steering TCP 443 for \(hosts.count) host suffixes and \(addresses.count) AI-host addresses (re-checked per flow, then by SNI in the agent) to 127.0.0.1:\(GuardConstants.transparentPort)")
        setTunnelNetworkSettings(settings) { [weak self, log] error in
            if let error {
                log.error("setTunnelNetworkSettings failed: \(error.localizedDescription, privacy: .public)")
                self?.queue.async { [weak self] in
                    self?.appliedHosts = nil
                    self?.appliedAddresses = nil
                }
            }
            completion?(error)
        }
    }

    private static func rule(forHost host: String) -> NENetworkRule {
        if #available(macOS 15.0, *) {
            return NENetworkRule(destinationHostEndpoint: Network.NWEndpoint.hostPort(host: .init(host), port: 443), protocol: .TCP)
        }
        return NENetworkRule(destinationHost: NWHostEndpoint(hostname: host, port: "443"), protocol: .TCP)
    }

    private static func rule(forAddress address: String) -> NENetworkRule {
        let prefix = address.contains(":") ? 128 : 32
        if #available(macOS 15.0, *) {
            return NENetworkRule(destinationNetworkEndpoint: Network.NWEndpoint.hostPort(host: .init(address), port: 443), prefix: prefix, protocol: .TCP)
        }
        return NENetworkRule(destinationNetwork: NWHostEndpoint(hostname: address, port: "443"), prefix: prefix, protocol: .TCP)
    }

    override func stopProxy(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        monitor.stop()
        queue.async { [self] in
            for relay in Array(relays.values) { relay.abort() }
            relays.removeAll()
            completionHandler()
        }
    }

    override func handleNewFlow(_ flow: NEAppProxyFlow) -> Bool {
        let tcp = flow as? NEAppProxyTCPFlow
        let (host, port) = tcp.map(Self.remote(of:)) ?? (nil, nil)
        let meta = flow.metaData
        let state = ExtensionState.shared
        let addresses = state.addresses
        let catalogue = state.snapshot().1
        let verdict = ProxySteering.decide(isTCP: tcp != nil, host: host, port: port, catalogue: catalogue,
                                           ownAgent: SigningIdentity.isOwnAgent(signingId: meta.sourceAppSigningIdentifier, auditToken: meta.sourceAppAuditToken),
                                           excludedApp: SigningIdentity.isExcludedCodex(signingId: meta.sourceAppSigningIdentifier, auditToken: meta.sourceAppAuditToken, catalogue: catalogue),
                                           hostForAddress: { addresses.host(for: $0) })
        guard verdict.steers, let tcp, let host else { return false }
        let steeringHost: String
        if case let .steerByAddress(_, learnt) = verdict {
            steeringHost = learnt
            log.notice("steering \(host, privacy: .public):\(port ?? ProxySteering.steeredPort) (an address last seen for \(learnt, privacy: .public), possibly shared; the agent decides by SNI) from \(meta.sourceAppSigningIdentifier, privacy: .public) through Guard's owned relay")
        } else {
            steeringHost = HostMatcher.normalise(host)
            log.notice("steering \(host, privacy: .public):\(port ?? ProxySteering.steeredPort) from \(meta.sourceAppSigningIdentifier, privacy: .public) through Guard's owned relay")
        }
        var preamble = ProxyProtocolV1.data(sourceHost: nil, sourcePort: nil, destinationHost: host, destinationPort: port ?? ProxySteering.steeredPort)
        if attributionSigner.isEnabled() {
            let verification = SigningIdentity.relayIdentity(signingId: meta.sourceAppSigningIdentifier, auditToken: meta.sourceAppAuditToken)
            attributionDiagnostics.record(verification.reason)
            if let attribution = attributionSigner.line(proxyLine: preamble, identity: verification.identity, steeringHost: steeringHost) {
                preamble.append(attribution)
                attributionDiagnostics.record(.emitted)
            } else { attributionDiagnostics.record(.signingFailed) }
        } else { attributionDiagnostics.record(.leaseDisabled) }
        let relay = FlowRelay(flow: AppFlow(tcp), destinationHost: host, destinationPort: port ?? ProxySteering.steeredPort, preamble: preamble, queue: queue, log: log, monitor: monitor)
        queue.async { [self] in
            let id = ObjectIdentifier(relay)
            relays[id] = relay
            relay.onFinish = { [weak self] in self?.relays.removeValue(forKey: id) }
            relay.start()
        }
        return true
    }

    private static func remote(of flow: NEAppProxyTCPFlow) -> (String?, Int?) {
        var host: String?
        var port: Int?
        if #available(macOS 15.0, *) {
            (host, port) = EndpointParts.of(flow.remoteFlowEndpoint)
        } else if let endpoint = flow.remoteEndpoint as? NWHostEndpoint {
            (host, port) = (endpoint.hostname, Int(endpoint.port))
        }
        if let name = flow.remoteHostname, !name.isEmpty { host = name }
        return (host, port)
    }
}

private final class AppFlow: RelayClientFlow {
    private let flow: NEAppProxyTCPFlow
    init(_ flow: NEAppProxyTCPFlow) { self.flow = flow }

    func open(_ completion: @escaping (Error?) -> Void) {
        if #available(macOS 15.0, *) {
            flow.open(withLocalFlowEndpoint: nil, completionHandler: completion)
        } else {
            flow.open(withLocalEndpoint: nil, completionHandler: completion)
        }
    }

    func readData(_ completion: @escaping (Data?, Error?) -> Void) { flow.readData(completionHandler: completion) }
    func write(_ data: Data, _ completion: @escaping (Error?) -> Void) { flow.write(data, withCompletionHandler: completion) }

    func close(_ error: Error?) {
        flow.closeReadWithError(error)
        flow.closeWriteWithError(error)
    }
}
