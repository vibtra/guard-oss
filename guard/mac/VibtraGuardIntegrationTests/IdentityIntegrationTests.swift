// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import XCTest

final class IdentityIntegrationTests: XCTestCase {
    private func expected(_ name: String, default value: String) -> String {
        let env = ProcessInfo.processInfo.environment[name] ?? ""
        return env.isEmpty ? value : env
    }

    func testIdentifiersComeFromTheBuiltBundle() {
        let team = expected("GUARD_EXPECT_TEAM_ID", default: "P2UU927A6W")
        let app = expected("GUARD_EXPECT_APP_ID", default: "app.vibtra.guard")
        let ext = expected("GUARD_EXPECT_EXTENSION_ID", default: "app.vibtra.guard.extension")
        XCTAssertEqual(GuardConstants.teamId, team)
        XCTAssertEqual(GuardConstants.appBundleId, app)
        XCTAssertEqual(GuardConstants.extensionBundleId, ext)
        XCTAssertEqual(GuardConstants.appGroup, team + "." + app)
        XCTAssertEqual(GuardConstants.extensionMachService, team + "." + ext + ".xpc")
        XCTAssertEqual(GuardConstants.agentSigningId, app + ".agent")
        XCTAssertTrue(GuardConstants.isOwnAgent(signingId: app + ".agent"))
        XCTAssertTrue(GuardConstants.isOwnAgent(signingId: ext))
        XCTAssertFalse(GuardConstants.isOwnAgent(signingId: team == "P2UU927A6W" ? "com.example.guard.agent" : "app.vibtra.guard.agent"))
    }
}
