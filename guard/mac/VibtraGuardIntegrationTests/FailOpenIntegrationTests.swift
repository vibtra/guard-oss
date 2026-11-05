// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Darwin
import Foundation
import Network
import os
import XCTest

final class FailOpenIntegrationTests: XCTestCase {
    private let queue = DispatchQueue(label: "app.vibtra.guard.integration.fail-open")
    private let log = Logger(subsystem: "app.vibtra.guard.integration", category: "fail-open")

    private static let clientHello: Data = {
        var body: [UInt8] = [0x03, 0x03] + [UInt8](repeating: 0x22, count: 32) + [0x00, 0x00, 0x02, 0x13, 0x01, 0x01, 0x00]
        let host = [UInt8]("fail-open.example".utf8)
        let sniList: [UInt8] = [0x00, UInt8(host.count >> 8), UInt8(host.count & 0xff)] + host
        let sniData: [UInt8] = [UInt8(sniList.count >> 8), UInt8(sniList.count & 0xff)] + sniList
        let sni: [UInt8] = [0x00, 0x00, UInt8(sniData.count >> 8), UInt8(sniData.count & 0xff)] + sniData
        let exts: [UInt8] = sni + [0x00, 0x2b, 0x00, 0x03, 0x02, 0x03, 0x04]
        body += [UInt8(exts.count >> 8), UInt8(exts.count & 0xff)] + exts
        let hs: [UInt8] = [0x01, 0x00, UInt8(body.count >> 8), UInt8(body.count & 0xff)] + body
        return Data([0x16, 0x03, 0x01, UInt8(hs.count >> 8), UInt8(hs.count & 0xff)] + hs)
    }()
    private static let serverHello = Data("SERVER-HELLO".utf8)

    private final class Destination: @unchecked Sendable {
        let listener: NWListener
        private let lock = NSLock()
        private var received: [Data] = []
        private var connections: [NWConnection] = []

        init(queue: DispatchQueue) throws {
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            listener = try NWListener(using: params)
            listener.newConnectionHandler = { [weak self] c in self?.serve(c, queue: queue) }
            let ready = DispatchSemaphore(value: 0)
            listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
            listener.start(queue: queue)
            _ = ready.wait(timeout: .now() + 5)
        }

        var port: UInt16 { listener.port?.rawValue ?? 0 }
        var hellos: [Data] { lock.withLock { received } }

        private func serve(_ c: NWConnection, queue: DispatchQueue) {
            lock.withLock { connections.append(c) }
            var got = Data()
            var answered = false
            func read() {
                c.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
                    guard let self else { return }
                    if answered {
                        if let data, !data.isEmpty { c.send(content: data, completion: .idempotent) }
                        if error == nil, !done { read() }
                        return
                    }
                    if let data { got.append(data) }
                    if got.count >= FailOpenIntegrationTests.clientHello.count {
                        self.lock.withLock { self.received.append(got) }
                        answered = true
                        c.send(content: FailOpenIntegrationTests.serverHello, completion: .idempotent)
                        if error == nil, !done { read() }
                        return
                    }
                    if error == nil, !done { read() }
                }
            }
            c.start(queue: queue)
            read()
        }

        func stop() {
            listener.cancel()
            let open = lock.withLock { connections }
            open.forEach { $0.cancel() }
        }
    }

    private final class WrongAnswer: @unchecked Sendable {
        let listener: NWListener
        private let lock = NSLock()
        private var connections: [NWConnection] = []

        init(queue: DispatchQueue) throws {
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            listener = try NWListener(using: params)
            listener.newConnectionHandler = { [weak self] c in
                self?.lock.withLock { self?.connections.append(c) }
                c.start(queue: queue)
                c.send(content: Data("HTTP/1.1 400 Bad Request\r\n\r\n".utf8), completion: .idempotent)
            }
            let ready = DispatchSemaphore(value: 0)
            listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
            listener.start(queue: queue)
            _ = ready.wait(timeout: .now() + 5)
        }

        var port: UInt16 { listener.port?.rawValue ?? 0 }

        func stop() {
            listener.cancel()
            let open = lock.withLock { connections }
            open.forEach { $0.cancel() }
        }
    }

    private final class SplitAnswer: @unchecked Sendable {
        let listener: NWListener
        private let lock = NSLock()
        private var connections: [NWConnection] = []
        private var received: [Data] = []

        init(queue: DispatchQueue) throws {
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            listener = try NWListener(using: params)
            listener.newConnectionHandler = { [weak self] c in
                guard let self else { return }
                self.lock.withLock { self.connections.append(c) }
                c.start(queue: queue)
                self.answer(c, queue: queue, got: Data())
            }
            let ready = DispatchSemaphore(value: 0)
            listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
            listener.start(queue: queue)
            _ = ready.wait(timeout: .now() + 5)
        }

        var port: UInt16 { listener.port?.rawValue ?? 0 }
        var lines: [Data] { lock.withLock { received } }

        private func answer(_ c: NWConnection, queue: DispatchQueue, got: Data) {
            c.receive(minimumIncompleteLength: 1, maximumLength: 64) { [weak self] data, _, done, error in
                guard let self else { return }
                let all = got + (data ?? Data())
                guard all.last == 0x0a else {
                    if error == nil, !done { self.answer(c, queue: queue, got: all) }
                    return
                }
                self.lock.withLock { self.received.append(all) }
                c.send(content: Data("VIBTRA-GU".utf8), completion: .idempotent)
                queue.asyncAfter(deadline: .now() + 0.2) { c.send(content: Data("ARD OK\r\n".utf8), completion: .idempotent) }
            }
        }

        func stop() {
            listener.cancel()
            let open = lock.withLock { connections }
            open.forEach { $0.cancel() }
        }
    }

    private final class Front: @unchecked Sendable {
        let listener: NWListener
        private let lock = NSLock()
        private var relays: [FlowRelay] = []
        var config: RelayConfig
        private(set) var recoveries = 0
        private(set) var successfulProbes = 0

        init(config: RelayConfig, destinationPort: UInt16, monitor: AgentMonitor, queue: DispatchQueue, log: Logger) throws {
            self.config = config
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            listener = try NWListener(using: params)
            monitor.onRecovery = { [weak self] in
                guard let self else { return }
                self.recoveries += 1
                self.retireDirect()
            }
            monitor.onProbeSuccess = { [weak self] in
                guard let self else { return }
                self.successfulProbes += 1
                self.retireDirect()
            }
            listener.newConnectionHandler = { [weak self] c in
                guard let self else { return }
                c.start(queue: queue)
                let preamble = ProxyProtocolV1.data(sourceHost: nil, sourcePort: nil, destinationHost: "127.0.0.1", destinationPort: Int(destinationPort))
                let relay = FlowRelay(flow: SocketFlow(c), destinationHost: "127.0.0.1", destinationPort: Int(destinationPort), preamble: preamble,
                                      config: self.lock.withLock { self.config }, queue: queue, log: log, monitor: monitor)
                self.lock.withLock { self.relays.append(relay) }
                relay.start()
            }
            let ready = DispatchSemaphore(value: 0)
            listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
            listener.start(queue: queue)
            _ = ready.wait(timeout: .now() + 5)
        }

        var port: UInt16 { listener.port?.rawValue ?? 0 }
        var last: FlowRelay? { lock.withLock { relays.last } }
        func setReplayCapacity(_ n: Int) { lock.withLock { config.replayCapacity = n } }

        private func retireDirect() {
            let snapshot = lock.withLock { relays }
            snapshot.forEach { $0.closeDirectOnRecovery() }
        }

        func stop() {
            listener.cancel()
            let snapshot = lock.withLock { relays }
            snapshot.forEach { $0.abort() }
        }
    }

    private enum Outcome: Equatable { case answered(Data), closed, timedOut }

    private final class PersistentClient: @unchecked Sendable {
        private let connection: NWConnection
        private let lock = NSLock()
        private var bytes = Data()
        private var ended = false
        var received: Data { lock.withLock { bytes } }
        var closed: Bool { lock.withLock { ended } }

        init(port: UInt16, first: Data = FailOpenIntegrationTests.clientHello) {
            connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
            connection.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    self.send(first)
                    self.read()
                case .failed, .cancelled: self.lock.withLock { self.ended = true }
                default: break
                }
            }
            connection.start(queue: DispatchQueue(label: "app.vibtra.guard.integration.persistent-client"))
        }

        func send(_ data: Data) { connection.send(content: data, completion: .idempotent) }

        private func read() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
                guard let self else { return }
                self.lock.withLock {
                    if let data { self.bytes.append(data) }
                    if done || error != nil { self.ended = true }
                }
                if !done, error == nil { self.read() }
            }
        }

        func stop() { connection.cancel() }
    }

    private func roundTrip(port: UInt16, limit: TimeInterval = 12) -> (Outcome, TimeInterval) {
        let started = Date()
        let c = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        let clientQueue = DispatchQueue(label: "app.vibtra.guard.integration.client")
        let lock = NSLock()
        var outcome: Outcome?
        let done = DispatchSemaphore(value: 0)
        let settle: (Outcome) -> Void = { o in
            lock.lock(); defer { lock.unlock() }
            guard outcome == nil else { return }
            outcome = o
            done.signal()
        }
        var got = Data()
        func read() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, isDone, error in
                if let data { got.append(data) }
                if got.count >= Self.serverHello.count { settle(.answered(got)); return }
                if error != nil || isDone { settle(.closed); return }
                read()
            }
        }
        c.stateUpdateHandler = { state in
            switch state {
            case .ready:
                c.send(content: Self.clientHello, completion: .idempotent)
                read()
            case .failed: settle(.closed)
            default: break
            }
        }
        c.start(queue: clientQueue)
        if done.wait(timeout: .now() + limit) == .timedOut { settle(.timedOut) }
        c.cancel()
        lock.lock(); defer { lock.unlock() }
        return (outcome ?? .timedOut, Date().timeIntervalSince(started))
    }

    private func onQueue<T>(_ body: () -> T) -> T { queue.sync(execute: body) }

    private func startAgent() throws -> GuardAgent {
        let agent = try GuardAgent()
        try agent.start()
        addTeardownBlock { agent.remove() }
        return agent
    }

    func testAStoppedAgentNeverHangsASteeredConnection() throws {
        let agent = try startAgent()
        let pid = agent.pid
        var config = RelayConfig()
        config.agentPort = agent.transparentPort
        let monitor = AgentMonitor(config: config, queue: queue, log: log)
        let destination = try Destination(queue: queue)
        let front = try Front(config: config, destinationPort: destination.port, monitor: monitor, queue: queue, log: log)
        defer {
            monitor.stop()
            onQueue {
                front.stop()
                destination.stop()
            }
        }
        monitor.start()

        XCTAssertTrue(Wait.until(10) { monitor.usable }, "the health round trip reaches the running agent")
        let (viaAgent, viaAgentTook) = roundTrip(port: front.port)
        XCTAssertEqual(viaAgent, .answered(Self.serverHello), "through the agent (tunnelled blind by address)")
        XCTAssertLessThan(viaAgentTook, 2)
        XCTAssertFalse(onQueue { front.last?.wentDirect ?? true }, "went through the agent, not around it")
        XCTAssertEqual(destination.hellos.last, Self.clientHello)

        XCTAssertEqual(kill(pid, SIGSTOP), 0)
        let before = destination.hellos.count
        let (replayed, replayTook) = roundTrip(port: front.port)
        XCTAssertEqual(replayed, .answered(Self.serverHello), "never a hang: replayed straight to the destination")
        XCTAssertLessThan(replayTook, FlowRelayPlan.answerDeadline + 1.5, "about 3 s, not the client's 12 s timeout (took \(replayTook) s)")
        XCTAssertTrue(onQueue { front.last?.wentDirect ?? false })
        XCTAssertEqual(destination.hellos.count, before + 1)
        XCTAssertEqual(destination.hellos.last, Self.clientHello, "the replay is byte-for-byte what the app sent")

        XCTAssertTrue(Wait.until(6.5) { !monitor.usable }, "a stopped agent is marked down within two 2 s probe rounds of 0.75 s each, plus 1 s")
        let catalogue = try GuardDocuments.decodeCatalogue(Data(contentsOf: IntegrationPaths.seedCatalogue))
        XCTAssertEqual(ProxySteering.decide(isTCP: true, host: "chatgpt.com", port: 443, catalogue: catalogue, ownAgent: false),
                       .steer(serviceId: "openai-chatgpt"))
        let directStarted = Date()
        let persistent = PersistentClient(port: front.port)
        defer { persistent.stop() }
        XCTAssertTrue(Wait.until(2) { persistent.received == Self.serverHello })
        XCTAssertLessThan(Date().timeIntervalSince(directStarted), 2, "known-down should not wait for an agent timeout")
        let directRelay = onQueue { front.last }
        XCTAssertEqual(onQueue { directRelay?.phase }, .direct)
        persistent.send(Data("still-direct".utf8))
        XCTAssertTrue(Wait.until(2) { persistent.received == Self.serverHello + Data("still-direct".utf8) })
        XCTAssertFalse(persistent.closed, "the test must retain its direct TCP connection")

        monitor.stop()
        onQueue { monitor.reached() }
        front.setReplayCapacity(Self.clientHello.count)
        let hellosBeforeFull = destination.hellos.count
        let (full, _) = roundTrip(port: front.port)
        XCTAssertEqual(full, .answered(Self.serverHello), "a first flight that fills the replay buffer exactly is still replayed")
        XCTAssertTrue(onQueue { front.last?.wentDirect ?? false })
        XCTAssertEqual(destination.hellos.count, hellosBeforeFull + 1)
        XCTAssertEqual(destination.hellos.last, Self.clientHello)
        front.setReplayCapacity(Self.clientHello.count - 1)
        let (unreplayable, unreplayableTook) = roundTrip(port: front.port)
        XCTAssertEqual(unreplayable, .closed, "closed with an error instead of hanging")
        XCTAssertLessThan(unreplayableTook, FlowRelayPlan.answerDeadline + 1.5)
        front.setReplayCapacity(ReplayBuffer.defaultCapacity)

        XCTAssertTrue(Wait.until(2) { persistent.closed })
        onQueue { monitor.missed("test outage") }
        XCTAssertTrue(monitor.usable, "one miss is not an outage")
        onQueue {
            monitor.reached()
            monitor.missed("test outage")
        }
        XCTAssertTrue(monitor.usable, "an answer in between starts the count again")
        onQueue { monitor.missed("test outage") }
        XCTAssertFalse(monitor.usable, "two misses in a row mark the agent down")
        let held = PersistentClient(port: front.port)
        defer { held.stop() }
        XCTAssertTrue(Wait.until(2) { held.received == Self.serverHello })
        let heldRelay = onQueue { front.last }
        XCTAssertEqual(onQueue { heldRelay?.phase }, .direct)

        XCTAssertEqual(kill(pid, SIGCONT), 0)
        monitor.start()
        XCTAssertTrue(Wait.until(AgentHealth.probeEvery + AgentHealth.probeDeadline + 1) { monitor.usable }, "a resumed agent is used again")
        XCTAssertTrue(Wait.until(2) { held.closed }, "the existing direct socket must not survive recovery")
        XCTAssertEqual(onQueue { heldRelay?.phase }, .closed)
        let (again, _) = roundTrip(port: front.port)
        XCTAssertEqual(again, .answered(Self.serverHello))
        XCTAssertFalse(onQueue { front.last?.wentDirect ?? true })

        let protected = PersistentClient(port: front.port)
        defer { protected.stop() }
        XCTAssertTrue(Wait.until(2) { protected.received == Self.serverHello })
        let protectedRelay = onQueue { front.last }
        XCTAssertEqual(onQueue { protectedRelay?.phase }, .viaAgent)
        monitor.stop()
        onQueue { }
        XCTAssertEqual(kill(pid, SIGSTOP), 0)
        let healthyFallback = PersistentClient(port: front.port)
        defer { healthyFallback.stop() }
        XCTAssertTrue(Wait.until(FlowRelayPlan.answerDeadline + 2) { healthyFallback.received == Self.serverHello })
        let fallbackRelay = onQueue { front.last }
        XCTAssertEqual(onQueue { fallbackRelay?.phase }, .direct)
        XCTAssertTrue(monitor.usable, "this fallback must not manufacture an outage")
        let recoveries = onQueue { front.recoveries }
        let probes = onQueue { front.successfulProbes }
        XCTAssertEqual(kill(pid, SIGCONT), 0)
        monitor.start()
        XCTAssertTrue(Wait.until(3) { onQueue { front.successfulProbes > probes } })
        XCTAssertEqual(onQueue { front.recoveries }, recoveries, "already-up probe is not a recovery transition")
        XCTAssertTrue(Wait.until(2) { healthyFallback.closed })
        XCTAssertEqual(onQueue { fallbackRelay?.phase }, .closed)
        XCTAssertEqual(onQueue { protectedRelay?.phase }, .viaAgent)
        XCTAssertFalse(protected.closed, "healthy inspected connection must remain intact")
        protected.send(Data("protected-after-recovery".utf8))
        XCTAssertTrue(Wait.until(2) { protected.received == Self.serverHello + Data("protected-after-recovery".utf8) })
    }

    func testOnlyTheAgentsHealthAnswerMarksItUp() throws {
        let impostor = try WrongAnswer(queue: queue)
        let destination = try Destination(queue: queue)
        var config = RelayConfig()
        config.agentPort = impostor.port
        let monitor = AgentMonitor(config: config, queue: queue, log: log)
        let front = try Front(config: config, destinationPort: destination.port, monitor: monitor, queue: queue, log: log)
        defer {
            monitor.stop()
            onQueue {
                front.stop()
                destination.stop()
                impostor.stop()
            }
        }
        XCTAssertEqual(monitor.state, .unknown)
        XCTAssertFalse(monitor.usable, "unknown health counts as down")
        let (beforeProbe, beforeProbeTook) = roundTrip(port: front.port)
        XCTAssertEqual(beforeProbe, .answered(Self.serverHello), "before any probe answers, an owned flow goes straight to its destination")
        XCTAssertLessThan(beforeProbeTook, 2)
        XCTAssertTrue(onQueue { front.last?.wentDirect ?? false })

        monitor.start()
        XCTAssertTrue(Wait.until(6.5) { monitor.state == .down },
                      "a listener that answers something other than the health line is never the agent")
        XCTAssertFalse(monitor.usable)

        let agent = try startAgent()
        var healthy = RelayConfig()
        healthy.agentPort = agent.transparentPort
        let agentMonitor = AgentMonitor(config: healthy, queue: queue, log: log)
        defer { agentMonitor.stop() }
        agentMonitor.start()
        XCTAssertTrue(Wait.until(3.75) { agentMonitor.usable },
                      "one answered health line from the real agent marks it up")
        XCTAssertEqual(agentMonitor.state, .up)
    }

    func testAHealthAnswerInTwoPiecesIsReadToTheEnd() throws {
        let agent = try SplitAnswer(queue: queue)
        var config = RelayConfig()
        config.agentPort = agent.port
        let monitor = AgentMonitor(config: config, queue: queue, log: log)
        defer {
            monitor.stop()
            onQueue { agent.stop() }
        }
        monitor.start()
        XCTAssertTrue(Wait.until(3.75) { monitor.state == .up }, "a partial answer means keep reading, not a wrong answer")
        XCTAssertEqual(agent.lines.first.map { String(decoding: $0, as: UTF8.self) }, "PROXY UNKNOWN vibtra-health\r\n",
                       "the probe is this legal PROXY v1 line")
    }

    func testADirectLegThatNeverConnectsIsClosedAtItsDeadline() throws {
        var config = RelayConfig()
        config.agentPort = LoopbackPort.free()
        config.directDeadline = 2
        let monitor = AgentMonitor(config: config, queue: queue, log: log)
        let refused = LoopbackPort.free()
        let front = try Front(config: config, destinationPort: refused, monitor: monitor, queue: queue, log: log)
        defer { onQueue { front.stop() } }
        let (outcome, took) = roundTrip(port: front.port, limit: 12)
        XCTAssertEqual(outcome, .closed, "a destination that never answers closes the flow with an error")
        XCTAssertLessThan(took, config.directDeadline + 2, "and never hangs past the direct deadline (took \(took) s)")
        XCTAssertEqual(onQueue { front.last?.phase }, .closed)
    }

    func testAFirstFlightThatOutgrowsTheReplayWhileGoingDirectIsClosed() throws {
        let agent = try startAgent()
        var config = RelayConfig()
        config.agentPort = agent.transparentPort
        config.directDeadline = 12
        config.replayCapacity = 4096
        let monitor = AgentMonitor(config: config, queue: queue, log: log)
        let refused = LoopbackPort.free()
        let front = try Front(config: config, destinationPort: refused, monitor: monitor, queue: queue, log: log)
        defer {
            monitor.stop()
            onQueue { front.stop() }
        }
        monitor.start()
        XCTAssertTrue(Wait.until(10) { monitor.usable })
        monitor.stop()
        onQueue { }
        XCTAssertEqual(kill(agent.pid, SIGSTOP), 0)
        let client = PersistentClient(port: front.port, first: Data(repeating: 0x16, count: 1024))
        defer { client.stop() }
        XCTAssertTrue(Wait.until(FlowRelayPlan.answerDeadline + 2) { self.onQueue { front.last?.phase } == .toDestination },
                      "a silent agent is abandoned for the direct leg")
        let sent = Date()
        client.send(Data(repeating: 0x17, count: 8192))
        XCTAssertTrue(Wait.until(3) { client.closed }, "bytes the replay can no longer hold close the flow instead of continuing headless")
        XCTAssertLessThan(Date().timeIntervalSince(sent), config.directDeadline - 5, "closed by the overflow, not by the direct deadline")
        XCTAssertEqual(onQueue { front.last?.phase }, .closed)
        XCTAssertFalse(onQueue { front.last?.wentDirect ?? true })
    }
}
