// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import os
import Security

final class GuardFixture {
    static let upstreamBody = "upstream-ok"
    static let upstreamHosts = ["chatgpt.com", "chat.deepseek.com", "claude.ai", "us-central1-aiplatform.googleapis.com", GuardPolicy.customHost]

    let registry: FakeRegistry
    let upstream: HTTPStub
    let agent: GuardAgent
    let queue = DispatchQueue(label: "app.vibtra.guard.integration.extension")
    let log = Logger(subsystem: "app.vibtra.guard.integration", category: "extension")
    private var monitorValue: AgentMonitor?
    private var fronts: [SteeringFront] = []
    private var streams: [EventStream] = []

    init(policy: GuardPolicy = GuardPolicy(), upstreamHosts: [String] = GuardFixture.upstreamHosts) throws {
        registry = try FakeRegistry(policy: policy)
        upstream = try HTTPStub()
        upstream.handler = { _ in .text(200, GuardFixture.upstreamBody) }
        agent = try GuardAgent()
        do {
            try agent.enrol(registry)
            var upstreams: [String: UInt16] = [:]
            for host in upstreamHosts { upstreams[host] = upstream.port }
            try agent.start(upstreams: upstreams, syncEvery: 1)
            try waitForPolicy(policy.bundleVersion)
        } catch {
            tearDown()
            throw error
        }
    }

    func waitForPolicy(_ version: Int, timeout: TimeInterval = 20) throws {
        let status = agent.waitForStatus(timeout) { status in
            (status["bundleVersion"] as? Int) == version && (status["proxyListening"] as? Bool) == true
        }
        guard status != nil else {
            throw IntegrationError("the agent never activated bundle \(version): \((try? agent.status()) ?? [:])\n\(agent.logTail())")
        }
    }

    func mirroredDocuments() throws -> (bundle: Data, catalogue: Data) {
        (try Data(contentsOf: agent.profileFile(AgentPaths.bundleFile.lastPathComponent)),
         try Data(contentsOf: agent.profileFile(AgentPaths.catalogueFile.lastPathComponent)))
    }

    func extensionDocuments() throws -> GuardDocumentState {
        let mirrors = try mirroredDocuments()
        var state = GuardDocumentState()
        try state.load(bundleData: mirrors.bundle, catalogueData: mirrors.catalogue)
        return state
    }

    func relayConfig() -> RelayConfig {
        var config = RelayConfig()
        config.agentPort = agent.transparentPort
        config.directDeadline = 2
        return config
    }

    func monitor() throws -> AgentMonitor {
        if let monitorValue { return monitorValue }
        let monitor = AgentMonitor(config: relayConfig(), queue: queue, log: log)
        monitorValue = monitor
        monitor.start()
        guard Wait.until(10, { monitor.usable }) else { throw IntegrationError("the health probe never reached the agent") }
        return monitor
    }

    func front(_ route: SteeringRoute, catalogue: GuardCatalogue?, addresses: HostAddressCache = HostAddressCache()) throws -> SteeringFront {
        let front = try SteeringFront(route: route, catalogue: catalogue, addresses: addresses, config: relayConfig(),
                                      monitor: try monitor(), queue: queue, log: log)
        fronts.append(front)
        return front
    }

    func events() throws -> EventStream {
        let stream = EventStream(url: agent.url("/events"))
        streams.append(stream)
        guard Wait.until(10, { stream.isPrimed }) else { throw IntegrationError("the agent's /events stream did not open") }
        return stream
    }

    func anchor() throws -> SecCertificate { try agent.caCertificate() }

    func send(_ front: SteeringFront, serverName: String, _ request: Data) throws -> TLSExchange {
        try TLSClient.exchange(port: front.port, serverName: serverName, anchor: try anchor(), request: request)
    }

    func activityRow(_ eventId: String) -> [String: Any]? {
        agent.waitForActivity { rows in rows.contains { $0["eventId"] as? String == eventId } }?
            .first { $0["eventId"] as? String == eventId }
    }

    func tearDown() {
        streams.forEach { $0.close() }
        fronts.forEach { $0.stop() }
        monitorValue?.stop()
        agent.remove()
        upstream.stop()
        registry.stop()
    }
}
