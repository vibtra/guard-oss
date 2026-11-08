// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation

@MainActor
final class AgentSupervisor {
    enum State: Equatable {
        case stopped
        case starting
        case running(pid: Int32)
        case backingOff(seconds: Int, lastExit: Int32)
        case missingBinary
    }

    private(set) var state: State = .stopped { didSet { onChange?(state) } }
    var onChange: ((State) -> Void)?

    private var process: Process?
    private var wantRunning = false
    private var backoff = 1
    private var startedAt = Date.distantPast
    private var restartTask: Task<Void, Never>?
    private var adoptedPid: Int32?
    private var adoptedWatch: DispatchSourceProcess?

    func start() {
        wantRunning = true
        restartTask?.cancel()
        launch()
    }

    func adopt(pid: Int32) {
        wantRunning = true
        restartTask?.cancel()
        let watch = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        watch.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.adoptedExited() }
        }
        adoptedPid = pid
        adoptedWatch = watch
        watch.resume()
        startedAt = Date()
        state = .running(pid: pid)
        if kill(pid, 0) != 0 { adoptedExited() }
    }

    private func adoptedExited() {
        guard adoptedPid != nil else { return }
        releaseAdopted()
        exited(status: -1)
    }

    private func releaseAdopted() {
        adoptedWatch?.cancel()
        adoptedWatch = nil
        adoptedPid = nil
    }

    func stop() {
        if let adoptedPid { kill(adoptedPid, SIGTERM) }
        if let process, process.isRunning { process.terminate() }
        release()
        state = .stopped
    }

    func release() {
        wantRunning = false
        restartTask?.cancel()
        restartTask = nil
        releaseAdopted()
        process = nil
    }

    private func logHandle() -> FileHandle? {
        let fm = FileManager.default
        try? fm.createDirectory(at: AgentPaths.logDir, withIntermediateDirectories: true)
        if !fm.fileExists(atPath: AgentPaths.agentLog.path) { fm.createFile(atPath: AgentPaths.agentLog.path, contents: nil) }
        guard let handle = try? FileHandle(forWritingTo: AgentPaths.agentLog) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }

    private func launch() {
        guard AgentPaths.binaryPresent else { state = .missingBinary; return }
        state = .starting
        let p = Process()
        p.executableURL = AgentPaths.binary
        p.arguments = ["run", "--transparent", "127.0.0.1:\(GuardConstants.transparentPort)"]
        if let log = logHandle() {
            log.write(Data("--- \(ISO8601DateFormatter().string(from: Date())) starting vibtra-guard run\n".utf8))
            p.standardOutput = log
            p.standardError = log
        }
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            Task { @MainActor in self?.exited(status: status) }
        }
        do {
            try p.run()
            process = p
            startedAt = Date()
            state = .running(pid: p.processIdentifier)
        } catch {
            exited(status: -1)
        }
    }

    private func exited(status: Int32) {
        process = nil
        guard wantRunning else { state = .stopped; return }
        if Date().timeIntervalSince(startedAt) > 60 { backoff = 1 }
        let wait = backoff
        backoff = min(backoff * 2, 60)
        state = .backingOff(seconds: wait, lastExit: status)
        restartTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait) * 1_000_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run { if self?.wantRunning == true { self?.launch() } }
        }
    }

    nonisolated static func runOnce(_ arguments: [String]) async -> (Int32, String) {
        guard AgentPaths.binaryPresent else { return (127, "agent binary missing: build guard/agent (cargo build --release) and rebuild the app") }
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Process()
                p.executableURL = AgentPaths.binary
                p.arguments = arguments
                let pipe = Pipe()
                p.standardOutput = pipe
                p.standardError = pipe
                do { try p.run() } catch {
                    continuation.resume(returning: (126, "could not start the agent: \(error.localizedDescription)"))
                    return
                }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                continuation.resume(returning: (p.terminationStatus, String(decoding: data, as: UTF8.self)))
            }
        }
    }
}
