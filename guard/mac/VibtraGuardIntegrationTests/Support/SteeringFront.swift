// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import Network
import os

struct SteeringRoute {
    var host: String
    var port: Int = ProxySteering.steeredPort
    var ownAgent = false
    var excludedApp = false
}

final class SteeringFront: @unchecked Sendable {
    let listener: NWListener
    private let queue: DispatchQueue
    private let lock = NSLock()
    private let monitor: AgentMonitor
    private let log: Logger
    private var configValue: RelayConfig
    private var routeValue: SteeringRoute
    private var catalogueValue: GuardCatalogue?
    private var signerValue: NativeRelaySigner?
    private var identityValue: NativeRelayIdentity?
    private var preambleOverrideValue: Data?
    private var verdictsValue: [ProxySteering.Verdict] = []
    private var preamblesValue: [Data] = []
    private var relaysValue: [FlowRelay] = []
    private var rejected: [NWConnection] = []
    let addresses: HostAddressCache
    let diagnostics = NativeRelayDiagnostics(component: "integration-front")
    private let directHost = "127.0.0.1"
    private let directPort: Int

    init(route: SteeringRoute, catalogue: GuardCatalogue?, addresses: HostAddressCache = HostAddressCache(),
         config: RelayConfig, monitor: AgentMonitor, queue: DispatchQueue, log: Logger) throws {
        routeValue = route
        catalogueValue = catalogue
        self.addresses = addresses
        configValue = config
        self.monitor = monitor
        self.queue = queue
        self.log = log
        directPort = Int(LoopbackPort.free())
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: params)
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in if case .ready = state { ready.signal() } }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success, port != 0 else { throw IntegrationError("the steering front did not start") }
    }

    var port: UInt16 { listener.port?.rawValue ?? 0 }

    var route: SteeringRoute {
        get { lock.withLock { routeValue } }
        set { lock.withLock { routeValue = newValue } }
    }

    var catalogue: GuardCatalogue? {
        get { lock.withLock { catalogueValue } }
        set { lock.withLock { catalogueValue = newValue } }
    }

    var config: RelayConfig {
        get { lock.withLock { configValue } }
        set { lock.withLock { configValue = newValue } }
    }

    var preambleOverride: Data? {
        get { lock.withLock { preambleOverrideValue } }
        set { lock.withLock { preambleOverrideValue = newValue } }
    }

    func attribute(with signer: NativeRelaySigner?, identity: NativeRelayIdentity?) {
        lock.withLock {
            signerValue = signer
            identityValue = identity
        }
    }

    var verdicts: [ProxySteering.Verdict] { lock.withLock { verdictsValue } }
    var preambles: [Data] { lock.withLock { preamblesValue } }
    var relays: [FlowRelay] { lock.withLock { relaysValue } }
    var lastRelay: FlowRelay? { relays.last }

    func onQueue<T>(_ body: () -> T) -> T { queue.sync(execute: body) }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        let (route, catalogue, config, signer, identity, override) = lock.withLock {
            (routeValue, catalogueValue, configValue, signerValue, identityValue, preambleOverrideValue)
        }
        let addresses = self.addresses
        let verdict = ProxySteering.decide(isTCP: true, host: route.host, port: route.port, catalogue: catalogue,
                                           ownAgent: route.ownAgent, excludedApp: route.excludedApp,
                                           hostForAddress: { addresses.host(for: $0) })
        lock.withLock { verdictsValue.append(verdict) }
        guard override != nil || verdict.steers else {
            lock.withLock { rejected.append(connection) }
            connection.cancel()
            return
        }
        var preamble = override ?? ProxyProtocolV1.data(sourceHost: nil, sourcePort: nil, destinationHost: route.host, destinationPort: route.port)
        if override == nil, let signer {
            if signer.isEnabled(), let identity {
                if let line = signer.line(proxyLine: preamble, identity: identity) {
                    preamble.append(line)
                    diagnostics.record(.emitted)
                } else {
                    diagnostics.record(.signingFailed)
                }
            } else {
                diagnostics.record(.leaseDisabled)
            }
        }
        let relay = FlowRelay(flow: SocketFlow(connection), destinationHost: directHost, destinationPort: directPort,
                              preamble: preamble, config: config, queue: queue, log: log, monitor: monitor)
        lock.withLock {
            preamblesValue.append(preamble)
            relaysValue.append(relay)
        }
        relay.start()
    }

    func stop() {
        listener.cancel()
        let (open, closed) = lock.withLock { (relaysValue, rejected) }
        queue.sync { open.forEach { $0.abort() } }
        closed.forEach { $0.cancel() }
    }
}
