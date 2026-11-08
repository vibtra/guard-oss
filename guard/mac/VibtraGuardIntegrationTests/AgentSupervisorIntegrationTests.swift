// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import XCTest

@MainActor
final class AgentSupervisorIntegrationTests: XCTestCase {
    private func forgetLaunchedBinary() {
        UserDefaults.standard.removeObject(forKey: AgentSupervisor.launchedBinaryKey)
        addTeardownBlock { UserDefaults.standard.removeObject(forKey: AgentSupervisor.launchedBinaryKey) }
    }

    private func setEnvironment(_ name: String, _ value: String) {
        let previous = ProcessInfo.processInfo.environment[name]
        setenv(name, value, 1)
        addTeardownBlock { if let previous { setenv(name, previous, 1) } else { unsetenv(name) } }
    }

    private func useFakeAgent() throws -> URL {
        let fakeAgent = FileManager.default.temporaryDirectory.appendingPathComponent("vibtra-guard-\(UUID().uuidString)")
        try "#!/bin/sh\nexec /bin/sleep 30\n".write(to: fakeAgent, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fakeAgent.path)
        let logs = FileManager.default.temporaryDirectory.appendingPathComponent("vibtra-guard-logs-\(UUID().uuidString)")
        setEnvironment("VIBTRA_GUARD_AGENT_BIN", fakeAgent.path)
        setEnvironment("VIBTRA_GUARD_LOG_DIR", logs.path)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: fakeAgent)
            try? FileManager.default.removeItem(at: logs)
        }
        forgetLaunchedBinary()
        return fakeAgent
    }

    private func waitUntilEnded(_ process: Process) {
        let deadline = Date().addingTimeInterval(5)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
    }

    private func isLive(_ pid: Int32) -> Bool {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size && info.pbi_status != UInt32(SZOMB)
    }

    private func processName(_ pid: Int32) -> String {
        var name = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &name, UInt32(name.count)) > 0 else { return "" }
        return String(cString: name)
    }

    private func runningProcess() throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        try process.run()
        addTeardownBlock { if process.isRunning { process.terminate() } }
        return process
    }

    func testAnAdoptedAgentThatDiesIsRestarted() throws {
        forgetLaunchedBinary()
        let process = try runningProcess()
        let supervisor = AgentSupervisor()
        supervisor.adopt(pid: process.processIdentifier)
        XCTAssertEqual(supervisor.state, .running(pid: process.processIdentifier))

        let restarting = expectation(description: "the supervisor schedules a restart")
        supervisor.onChange = { state in
            if case .backingOff = state { restarting.fulfill() }
        }
        process.terminate()
        wait(for: [restarting], timeout: 5)
        supervisor.onChange = nil
        supervisor.stop()
    }

    func testStoppingEndsAnAdoptedAgent() throws {
        forgetLaunchedBinary()
        let process = try runningProcess()
        let supervisor = AgentSupervisor()
        supervisor.adopt(pid: process.processIdentifier)
        supervisor.stop()
        XCTAssertEqual(supervisor.state, .stopped)
        waitUntilEnded(process)
        XCTAssertFalse(process.isRunning)
    }

    func testReleasingLeavesAnAdoptedAgentRunning() throws {
        forgetLaunchedBinary()
        let process = try runningProcess()
        let supervisor = AgentSupervisor()
        supervisor.adopt(pid: process.processIdentifier)
        supervisor.release()

        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertTrue(process.isRunning, "quitting the app must leave the agent running")
    }

    func testAnAdoptedAgentFromAnOlderAppIsReplaced() throws {
        _ = try useFakeAgent()
        let process = try runningProcess()
        UserDefaults.standard.set("\(process.processIdentifier):an older build", forKey: AgentSupervisor.launchedBinaryKey)
        let supervisor = AgentSupervisor()
        let restarting = expectation(description: "the supervisor ends the older agent and schedules a new one")
        supervisor.onChange = { state in
            if case .backingOff = state { restarting.fulfill() }
        }
        supervisor.adopt(pid: process.processIdentifier)
        wait(for: [restarting], timeout: 5)
        supervisor.onChange = nil
        supervisor.stop()
        waitUntilEnded(process)
        XCTAssertFalse(process.isRunning)
    }

    func testAnAdoptedAgentIsKeptUnlessTheAppLaunchedItFromAnotherBuild() throws {
        _ = try useFakeAgent()
        let current = try XCTUnwrap(AgentPaths.binaryIdentity)
        for launched in [nil, "1:an older build", "this pid"] {
            let process = try runningProcess()
            let pid = process.processIdentifier
            if let launched {
                UserDefaults.standard.set(launched == "this pid" ? "\(pid):\(current)" : launched, forKey: AgentSupervisor.launchedBinaryKey)
            } else {
                UserDefaults.standard.removeObject(forKey: AgentSupervisor.launchedBinaryKey)
            }
            let supervisor = AgentSupervisor()
            supervisor.adopt(pid: pid)
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            XCTAssertTrue(process.isRunning, "an agent recorded as \(launched ?? "nothing") must be kept")
            supervisor.release()
        }
    }

    func testReleasingLeavesALaunchedAgentRunningOutsideTheAppsProcessGroup() throws {
        _ = try useFakeAgent()
        let supervisor = AgentSupervisor()
        supervisor.start()
        guard case .running(let pid) = supervisor.state else { return XCTFail("the agent did not start: \(supervisor.state)") }
        addTeardownBlock { kill(pid, SIGKILL) }
        supervisor.release()

        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(processName(pid), "sleep", "the supervisor must have launched the fake agent")
        XCTAssertTrue(isLive(pid), "quitting the app must leave the agent running")
        XCTAssertNotEqual(getpgid(pid), getpgrp(), "the agent must not share the app's process group, which can end with the app")
    }

    func testAgentProcessCheckRefusesOtherProcesses() throws {
        let process = try runningProcess()
        XCTAssertFalse(AgentPaths.isAgentProcess(process.processIdentifier))
    }
}
