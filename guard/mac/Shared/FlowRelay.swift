// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation
import Network
import os

public protocol RelayClientFlow: AnyObject {
    func open(_ completion: @escaping (Error?) -> Void)
    func readData(_ completion: @escaping (Data?, Error?) -> Void)
    func write(_ data: Data, _ completion: @escaping (Error?) -> Void)
    func close(_ error: Error?)
}

public struct RelayConfig: Sendable {
    public var agentHost = "127.0.0.1"
    public var agentPort: UInt16 = GuardConstants.transparentPort
    public var connectDeadline = AgentHealth.connectDeadline
    public var answerDeadline = FlowRelayPlan.answerDeadline
    public var directDeadline = FlowRelayPlan.directDeadline
    public var replayCapacity = ReplayBuffer.defaultCapacity
    public var probeDeadline = AgentHealth.probeDeadline
    public var probeEvery = AgentHealth.probeEvery

    public init() {}
}

public final class AgentMonitor: @unchecked Sendable {
    private let config: RelayConfig
    private let queue: DispatchQueue
    private let log: Logger
    private let lock = NSLock()
    private let queueKey = DispatchSpecificKey<Bool>()
    private var health = AgentHealth()
    private var recoveryHandler: (() -> Void)?
    private var probeSuccessHandler: (() -> Void)?
    private var running = false
    private var probe: NWConnection?
    private var next: DispatchWorkItem?

    public init(config: RelayConfig = RelayConfig(), queue: DispatchQueue, log: Logger) {
        self.config = config
        self.queue = queue
        self.log = log
        queue.setSpecific(key: queueKey, value: true)
    }

    public var usable: Bool { lock.lock(); defer { lock.unlock() }; return health.usable }
    public var state: AgentHealth.State { lock.lock(); defer { lock.unlock() }; return health.state }

    public var onRecovery: (() -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return recoveryHandler }
        set { lock.lock(); recoveryHandler = newValue; lock.unlock() }
    }

    public var onProbeSuccess: (() -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return probeSuccessHandler }
        set { lock.lock(); probeSuccessHandler = newValue; lock.unlock() }
    }

    public func reached() {
        guard DispatchQueue.getSpecific(key: queueKey) == true else {
            queue.async { [weak self] in self?.reached() }
            return
        }
        lock.lock()
        let changed = health.reached()
        let callback = recoveryHandler
        lock.unlock()
        if changed {
            log.notice("agent on \(self.config.agentHost, privacy: .public):\(self.config.agentPort) answers: steering AI flows to it")
            callback?()
        }
    }

    public func missed(_ why: String, fromFlow: Bool = false) {
        lock.lock(); let changed = health.missed(); lock.unlock()
        if changed {
            log.error("agent on \(self.config.agentHost, privacy: .public):\(self.config.agentPort) not answering (\(why, privacy: .public)): AI flows go direct until it does")
        }
        if fromFlow, running, probe == nil {
            next?.cancel()
            runProbe()
        }
    }

    public func recheck() {
        if running, probe == nil {
            next?.cancel()
            runProbe()
        }
    }

    public func start() {
        queue.async { [self] in
            guard !running else { return }
            running = true
            runProbe()
        }
    }

    public func stop() {
        queue.async { [self] in
            running = false
            next?.cancel()
            probe?.stateUpdateHandler = nil
            probe?.cancel()
            probe = nil
        }
    }

    private func runProbe() {
        guard running, probe == nil else { return }
        let connection = NWConnection(host: NWEndpoint.Host(config.agentHost), port: NWEndpoint.Port(rawValue: config.agentPort)!, using: .tcp)
        probe = connection
        var settled = false
        var received = Data()
        let settle: (Bool, String) -> Void = { [self] ok, why in
            guard !settled else { return }
            settled = true
            connection.stateUpdateHandler = nil
            connection.cancel()
            guard probe === connection else { return }
            probe = nil
            guard running else { return }
            if ok {
                reached()
                lock.lock(); let callback = probeSuccessHandler; lock.unlock()
                callback?()
            } else { missed(why) }
            schedule()
        }
        func readAnswer() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64) { data, _, isComplete, error in
                if let data { received.append(data) }
                switch AgentProbe.verdict(received) {
                case true?: settle(true, "")
                case false?: settle(false, "a wrong answer to the health line")
                case nil:
                    if let error { settle(false, "read failed: \(error.localizedDescription)") }
                    else if isComplete { settle(false, "closed without answering the health line") }
                    else { readAnswer() }
                }
            }
        }
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                connection.send(content: AgentProbe.line, completion: .contentProcessed { error in
                    if let error { settle(false, "write failed: \(error.localizedDescription)") } else { readAnswer() }
                })
            case .waiting(let error): settle(false, "waiting: \(error.localizedDescription)")
            case .failed(let error): settle(false, "failed: \(error.localizedDescription)")
            default: break
            }
        }
        let ms = Int(config.probeDeadline * 1000)
        queue.asyncAfter(deadline: .now() + config.probeDeadline) { settle(false, "no answer to the health line in \(ms) ms") }
        connection.start(queue: queue)
    }

    private func schedule() {
        guard running else { return }
        next?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.runProbe() }
        next = work
        queue.asyncAfter(deadline: .now() + config.probeEvery, execute: work)
    }
}

public final class FlowRelay: @unchecked Sendable {
    private let flow: RelayClientFlow
    private let destinationHost: String
    private let destinationPort: Int
    private let preamble: Data
    private let config: RelayConfig
    private let queue: DispatchQueue
    private let log: Logger
    private let monitor: AgentMonitor
    private var plan = FlowRelayPlan()
    private var replay: ReplayBuffer
    private var agent: NWConnection?
    private var direct: NWConnection?
    private var leg: NWConnection?
    private var legReady = false
    private var generation = 0
    private var flowOpened = false
    private var flowOpenCompleted = false
    private var afterOpen: [() -> Void] = []
    private var readInFlight = false
    private var clientEnded = false
    private var deadline: DispatchWorkItem?
    private var finished = false
    public var onFinish: (() -> Void)?
    public var phase: FlowRelayPlan.Phase { plan.phase }
    public private(set) var wentDirect = false

    public init(flow: RelayClientFlow, destinationHost: String, destinationPort: Int, preamble: Data, config: RelayConfig = RelayConfig(),
                queue: DispatchQueue, log: Logger, monitor: AgentMonitor) {
        self.flow = flow
        self.destinationHost = destinationHost
        self.destinationPort = destinationPort
        self.preamble = preamble
        self.config = config
        self.queue = queue
        self.log = log
        self.monitor = monitor
        self.replay = ReplayBuffer(capacity: config.replayCapacity)
    }

    public func start() {
        guard !finished, plan.phase == .toAgent, agent == nil else { return }
        if !monitor.usable {
            perform(plan.agent(.failed), why: "agent health not ready", countsAsMiss: false)
            return
        }
        let connection = NWConnection(host: NWEndpoint.Host(config.agentHost), port: NWEndpoint.Port(rawValue: config.agentPort)!, using: .tcp)
        agent = connection
        connection.stateUpdateHandler = { [weak self] state in self?.agentReported(state) }
        let secs = Int(config.connectDeadline)
        arm(config.connectDeadline) { [weak self] in self?.perform(self?.plan.agent(.deadline), why: "no connection in \(secs) s") }
        connection.start(queue: queue)
    }

    public func abort() { finish(nil) }

    public func closeDirectOnRecovery() {
        guard !finished, plan.phase == .toDestination || plan.phase == .direct else { return }
        log.notice("\(self.destinationHost, privacy: .public):\(self.destinationPort): agent recovered; closing direct fallback for an inspected reconnect")
        finish(NSError(domain: NSPOSIXErrorDomain, code: Int(ECONNRESET)))
    }

    private var recording: Bool { plan.phase == .awaitingAnswer || plan.phase == .toDestination }

    private func agentReported(_ state: NWConnection.State) {
        switch state {
        case .ready:
            perform(plan.agent(.ready), why: nil)
        case .waiting(let error):
            if plan.phase == .awaitingAnswer {
                perform(plan.agentAnswer(.closedEarly(replayable: replay.replayable)), why: "agent connection waiting: \(error.localizedDescription)")
            } else {
                perform(plan.agent(.waiting), why: "waiting: \(error.localizedDescription)")
            }
        case .failed(let error):
            switch plan.phase {
            case .toAgent: perform(plan.agent(.failed), why: "failed: \(error.localizedDescription)")
            case .awaitingAnswer: perform(plan.agentAnswer(.closedEarly(replayable: replay.replayable)), why: "agent connection failed: \(error.localizedDescription)")
            case .viaAgent: finish(error)
            default: break
            }
        case .cancelled:
            if plan.phase == .viaAgent { finish(nil) }
        default: break
        }
    }

    private func directReported(_ state: NWConnection.State) {
        switch state {
        case .ready: perform(plan.direct(.ready), why: nil)
        case .waiting(let error): perform(plan.direct(.waiting), why: "direct connection waiting: \(error.localizedDescription)")
        case .failed(let error):
            if plan.phase == .direct { finish(error) } else { perform(plan.direct(.failed), why: "direct connection failed: \(error.localizedDescription)") }
        case .cancelled:
            if plan.phase == .direct { finish(nil) }
        default: break
        }
    }

    private func perform(_ action: FlowRelayPlan.Action?, why: String?, countsAsMiss: Bool = true) {
        guard let action, !finished else { return }
        switch action {
        case .ignore:
            return
        case .openFlowViaAgent:
            disarm()
            guard let agent else { return }
            leg = agent
            let gen = generation
            let secs = Int(config.answerDeadline)
            arm(config.answerDeadline) { [weak self] in
                guard let self else { return }
                self.perform(self.plan.agentAnswer(.silent(replayable: self.replay.replayable)), why: "agent silent for \(secs) s",
                             countsAsMiss: false)
            }
            openFlow { [weak self] in
                guard let self, self.leg === agent, gen == self.generation else { return }
                agent.send(content: self.preamble, completion: .contentProcessed { [weak self] error in
                    guard let self, !self.finished, self.leg === agent else { return }
                    if error != nil {
                        self.perform(self.plan.agentAnswer(.closedEarly(replayable: self.replay.replayable)), why: "agent write failed")
                        return
                    }
                    self.legReady = true
                    self.readClient()
                })
                self.readUpstream(agent, generation: gen)
            }
        case .agentAnswered:
            disarm()
            replay.release()
            monitor.reached()
        case .fallBackDirect:
            disarm()
            if countsAsMiss { monitor.missed(why ?? "unreachable", fromFlow: true) } else { monitor.recheck() }
            generation += 1
            legReady = false
            leg = nil
            agent?.stateUpdateHandler = nil
            agent?.cancel()
            agent = nil
            let replaying = replay.bytes.count
            log.notice("\(self.destinationHost, privacy: .public):\(self.destinationPort): \(why ?? "agent unreachable", privacy: .public); relaying direct (fail open, replaying \(replaying) bytes)")
            let connection = NWConnection(host: NWEndpoint.Host(destinationHost), port: NWEndpoint.Port(rawValue: UInt16(clamping: destinationPort)) ?? 443, using: .tcp)
            direct = connection
            connection.stateUpdateHandler = { [weak self] state in self?.directReported(state) }
            arm(config.directDeadline) { [weak self] in self?.perform(self?.plan.direct(.deadline), why: "direct connection timed out") }
            connection.start(queue: queue)
        case .openFlowDirect:
            disarm()
            guard let direct else { return }
            wentDirect = true
            let begin = { [weak self] in
                guard let self, !self.finished else { return }
                guard self.replay.replayable else {
                    self.perform(.closeFlow, why: "the app's first flight outgrew the \(self.replay.capacity)-byte replay")
                    return
                }
                if !self.replay.bytes.isEmpty {
                    direct.send(content: self.replay.bytes, completion: .contentProcessed { [weak self] error in
                        if let error { self?.finish(error) }
                    })
                }
                if self.replay.sawEnd {
                    direct.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .idempotent)
                }
                self.replay.release()
                self.leg = direct
                self.legReady = true
                self.readClient()
                self.readUpstream(direct, generation: self.generation)
            }
            if !flowOpened { openFlow(begin) } else if flowOpenCompleted { begin() } else { afterOpen.append(begin) }
        case .closeFlow:
            log.error("\(self.destinationHost, privacy: .public): \(why ?? "closed", privacy: .public); closing the flow")
            finish(NSError(domain: NSPOSIXErrorDomain, code: Int(ETIMEDOUT)))
        }
    }

    private func arm(_ seconds: TimeInterval, _ body: @escaping () -> Void) {
        disarm()
        let work = DispatchWorkItem(block: body)
        deadline = work
        queue.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func disarm() {
        deadline?.cancel()
        deadline = nil
    }

    private func openFlow(_ then: @escaping () -> Void) {
        flowOpened = true
        afterOpen.append(then)
        flow.open { [weak self] error in
            guard let self else { return }
            self.queue.async {
                guard !self.finished else { return }
                if let error { self.finish(error); return }
                self.flowOpenCompleted = true
                let pending = self.afterOpen
                self.afterOpen = []
                pending.forEach { $0() }
            }
        }
    }

    private func readClient() {
        guard !finished, !readInFlight, !clientEnded else { return }
        readInFlight = true
        flow.readData { [weak self] data, error in
            guard let self else { return }
            self.queue.async {
                self.readInFlight = false
                guard !self.finished else { return }
                if let error { self.finish(error); return }
                guard let data, !data.isEmpty else {
                    self.clientEnded = true
                    if self.recording { self.replay.end() }
                    if self.legReady, let leg = self.leg {
                        leg.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .idempotent)
                    }
                    return
                }
                if self.recording {
                    self.replay.append(data)
                    if !self.replay.replayable, self.plan.phase == .toDestination {
                        self.perform(self.plan.direct(.unreplayable), why: "the app's first flight outgrew the \(self.replay.capacity)-byte replay")
                        return
                    }
                }
                guard self.legReady, let leg = self.leg else { return }
                leg.send(content: data, completion: .contentProcessed { [weak self] error in
                    guard let self else { return }
                    self.queue.async {
                        guard !self.finished, self.leg === leg else { return }
                        if error != nil, self.plan.phase == .awaitingAnswer, leg === self.agent {
                            self.perform(self.plan.agentAnswer(.closedEarly(replayable: self.replay.replayable)), why: "agent write failed before it answered", countsAsMiss: false)
                            return
                        }
                        if let error { self.finish(error); return }
                        self.readClient()
                    }
                })
            }
        }
    }

    private func readUpstream(_ connection: NWConnection, generation gen: Int) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            self.queue.async {
                guard !self.finished, gen == self.generation else { return }
                if let data, !data.isEmpty {
                    if self.plan.phase == .awaitingAnswer { self.perform(self.plan.agentAnswer(.firstBytes), why: nil) }
                    self.flow.write(data) { [weak self] error in
                        guard let self else { return }
                        self.queue.async {
                            guard !self.finished else { return }
                            if let error { self.finish(error); return }
                            if isComplete { self.finish(nil) } else { self.readUpstream(connection, generation: gen) }
                        }
                    }
                    return
                }
                if self.plan.phase == .awaitingAnswer, error != nil || isComplete {
                    self.perform(self.plan.agentAnswer(.closedEarly(replayable: self.replay.replayable)), why: "agent closed before answering", countsAsMiss: false)
                    return
                }
                if let error { self.finish(error); return }
                if isComplete { self.finish(nil) } else { self.readUpstream(connection, generation: gen) }
            }
        }
    }

    private func finish(_ error: Error?) {
        guard !finished else { return }
        finished = true
        plan.closed()
        disarm()
        flow.close(error)
        for connection in [agent, direct].compactMap({ $0 }) {
            connection.stateUpdateHandler = nil
            connection.cancel()
        }
        agent = nil
        direct = nil
        leg = nil
        afterOpen = []
        let done = onFinish
        onFinish = nil
        done?()
    }
}
