// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import XCTest

@MainActor
final class AgentSupervisorIntegrationTests: XCTestCase {
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

    func testAgentProcessCheckRefusesOtherProcesses() throws {
        let process = try runningProcess()
        XCTAssertFalse(AgentPaths.isAgentProcess(process.processIdentifier))
    }
}
