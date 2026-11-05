// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import XCTest

class GuardIntegrationCase: XCTestCase {
    private var fixtures: [GuardFixture] = []

    func makeFixture(_ policy: GuardPolicy = GuardPolicy()) throws -> GuardFixture {
        let fixture = try GuardFixture(policy: policy)
        fixtures.append(fixture)
        return fixture
    }

    func request(_ method: String = "GET", host: String, path: String, headers: [(String, String)] = [], body: Data? = nil) -> Data {
        HTTPWire.request(method, host: host, path: path, headers: headers, body: body)
    }

    override func tearDown() {
        let failed = (testRun?.totalFailureCount ?? 0) > 0
        for fixture in fixtures {
            if failed { print("--- agent log (\(fixture.agent.workDir.lastPathComponent)):\n\(fixture.agent.logTail())") }
            fixture.tearDown()
        }
        fixtures = []
        super.tearDown()
    }
}
