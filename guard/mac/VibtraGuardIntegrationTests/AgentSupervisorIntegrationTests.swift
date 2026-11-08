// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import XCTest

@MainActor
final class AgentSupervisorIntegrationTests: XCTestCase {
    private func forgetLaunchedBinary() {
        UserDefaults.standard.removeObject(forKey: AgentSupervisor.launchedBinaryKey)
        addTeardownBlock { UserDefaults.standard.removeObject(forKey: AgentSupervisor.launchedBinaryKey) }
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
        let process = try runningProcess()
        let supervisor = AgentSupervisor()
        supervisor.adopt(pid: process.processIdentifier)
        supervisor.stop()
        XCTAssertEqual(supervisor.state, .stopped)

        let deadline = Date().addingTimeInterval(5)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        XCTAssertFalse(process.isRunning)
    }

    func testReleasingLeavesAnAdoptedAgentRunning() throws {
        let process = try runningProcess()
        let supervisor = AgentSupervisor()
        supervisor.adopt(pid: process.processIdentifier)
        supervisor.release()

        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertTrue(process.isRunning, "quitting the app must leave the agent running")
    }

    func testAnAdoptedAgentFromAnOlderAppIsReplaced() throws {
        forgetLaunchedBinary()
        UserDefaults.standard.set("an older build", forKey: AgentSupervisor.launchedBinaryKey)
        let process = try runningProcess()
        let supervisor = AgentSupervisor()
        let restarting = expectation(description: "the supervisor ends the older agent and schedules a new one")
        supervisor.onChange = { state in
            if case .backingOff = state { restarting.fulfill() }
        }
        supervisor.adopt(pid: process.processIdentifier)
        wait(for: [restarting], timeout: 5)
        supervisor.onChange = nil
        supervisor.stop()
        XCTAssertFalse(process.isRunning)
    }

    func testReleasingLeavesALaunchedAgentRunningOutsideTheAppsProcessGroup() throws {
        let fakeAgent = FileManager.default.temporaryDirectory.appendingPathComponent("vibtra-guard-\(UUID().uuidString)")
        try "#!/bin/sh\nexec /bin/sleep 30\n".write(to: fakeAgent, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fakeAgent.path)
        let logs = FileManager.default.temporaryDirectory.appendingPathComponent("vibtra-guard-logs-\(UUID().uuidString)")
        let previous = ProcessInfo.processInfo.environment["VIBTRA_GUARD_AGENT_BIN"]
        setenv("VIBTRA_GUARD_AGENT_BIN", fakeAgent.path, 1)
        setenv("VIBTRA_GUARD_LOG_DIR", logs.path, 1)
        addTeardownBlock {
            if let previous { setenv("VIBTRA_GUARD_AGENT_BIN", previous, 1) } else { unsetenv("VIBTRA_GUARD_AGENT_BIN") }
            unsetenv("VIBTRA_GUARD_LOG_DIR")
            try? FileManager.default.removeItem(at: fakeAgent)
            try? FileManager.default.removeItem(at: logs)
        }

        forgetLaunchedBinary()
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
