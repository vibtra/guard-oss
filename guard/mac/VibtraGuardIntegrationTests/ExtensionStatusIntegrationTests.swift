// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import XCTest

final class ExtensionStatusIntegrationTests: XCTestCase {
    private func status(_ systemExtension: ExtensionSnapshot.SystemExtension, filter: Bool? = nil, proxy: Bool? = nil,
                        connection: ExtensionSnapshot.ProxyConnection = .invalid, error: String? = nil,
                        installed: String? = nil, bundled: String? = nil) -> ExtensionStatus {
        ExtensionStatus.from(ExtensionSnapshot(systemExtension: systemExtension, filterEnabled: filter, proxyEnabled: proxy,
                                               proxyConnection: connection, error: error, installedVersion: installed, bundledVersion: bundled))
    }

    func testARunningOldExtensionOffersAnUpdateWithoutStoppingProtection() {
        let state = status(.enabled, filter: true, proxy: true, connection: .connected, installed: "25", bundled: "26")
        XCTAssertEqual(state, .updateAvailable(installed: "25", bundled: "26", protection: .on))
        XCTAssertEqual(state.action, .update)
        XCTAssertFalse(state.action.turnsOnAfterActivation)
        XCTAssertTrue(state.isRunning, "documents are still pushed and events drained while an update waits")
        XCTAssertTrue(state.isProtectionOn)
        XCTAssertEqual(state.text, "On: AI sites go through Guard · Extension update available (25 → 26)")
    }

    func testAnUpdateKeepsOffAndPartialChoicesAsTheyAre() {
        let off = status(.enabled, filter: false, proxy: false, installed: "25", bundled: "26")
        XCTAssertEqual(off.action, .update)
        XCTAssertFalse(off.action.turnsOnAfterActivation)
        XCTAssertFalse(off.isRunning)
        let disabled = status(.disabled, filter: true, proxy: true, installed: "25", bundled: "26")
        XCTAssertEqual(disabled, .turnedOffInSettings)
        XCTAssertEqual(disabled.action, .openSettings, "the switch in System Settings is respected; an activation could turn it on")
        let partial = status(.enabled, filter: true, proxy: false, installed: "25", bundled: "26")
        XCTAssertEqual(partial.action, .update)
        XCTAssertFalse(partial.action.turnsOnAfterActivation, "an update never enables the proxy the person switched off")
        XCTAssertTrue(partial.text.contains("transparent proxy off"))
        XCTAssertTrue(ExtensionStatus.Action.install.turnsOnAfterActivation)
    }

    func testAFailedUpdateStaysVisibleWhileProtectionAndPolicyDeliveryContinue() {
        let state = status(.enabled, filter: true, proxy: true, connection: .connected, error: "replacement refused", installed: "25", bundled: "26")
        XCTAssertTrue(state.isProtectionOn)
        XCTAssertTrue(state.isRunning)
        XCTAssertEqual(state.text, "On: AI sites go through Guard · Extension update available (25 → 26) · replacement refused")
        XCTAssertEqual(state.action, .update)
    }

    func testAnExtensionThatRefusedThePolicyIsNotReportedAsOn() {
        let refusal = "The policy is older than the one already verified"
        let state = ExtensionStatus.from(ExtensionSnapshot(systemExtension: .enabled, filterEnabled: true, proxyEnabled: true, proxyConnection: .connected, policyRefusal: refusal))
        XCTAssertFalse(state.isProtectionOn)
        XCTAssertTrue(state.isRunning, "the app keeps offering it the agent's policy")
        XCTAssertEqual(state.text, "Partly on: the network extension refused Guard's policy (\(refusal))")
        XCTAssertEqual(ExtensionStatus.from(ExtensionSnapshot(systemExtension: .enabled, filterEnabled: true, proxyEnabled: true, proxyConnection: .connected)), .on,
                       "it is on again once it takes a policy")
    }

    func testAnUpdateNeedsTwoKnownDifferentVersionsAndActivatedCode() {
        for (installed, bundled) in [("26", "26"), (nil, "26"), ("25", nil), ("", "26"), ("25", "")] as [(String?, String?)] {
            XCTAssertEqual(status(.enabled, filter: true, proxy: true, connection: .connected, installed: installed, bundled: bundled), .on,
                           "\(installed ?? "nil") → \(bundled ?? "nil")")
        }
        XCTAssertEqual(status(.awaitingApproval, installed: "25", bundled: "26"), .needsApproval)
        XCTAssertEqual(status(.notInstalled, installed: "25", bundled: "26"), .notInstalled)
        XCTAssertEqual(status(.disabled, installed: "25", bundled: "26"), .turnedOffInSettings)
    }

    func testAnActivatedExtensionWithBothHalvesConnectedIsOnAfterARestart() {
        let state = status(.enabled, filter: true, proxy: true, connection: .connected)
        XCTAssertEqual(state, .on)
        XCTAssertTrue(state.isRunning, "documents are pushed and events drained after a restart")
        XCTAssertTrue(state.isProtectionOn)
        XCTAssertEqual(state.action, .turnOff)
        XCTAssertEqual(state.text, "On: AI sites go through Guard")
    }

    func testNothingReadYetIsCheckingUntilTheConfigurationsArrive() {
        let checking = status(.unknown)
        XCTAssertEqual(checking, .checking)
        XCTAssertFalse(checking.isRunning)
        XCTAssertEqual(checking.action, .none)
        XCTAssertEqual(checking.text, "Checking…")
        XCTAssertEqual(status(.unknown, filter: true, proxy: true, connection: .connected), .on,
                       "the configurations can answer before the system extension request does")
    }

    func testInstallApprovalAndSettingsStatesEachOfferTheirOneAction() {
        XCTAssertEqual(status(.notInstalled), .notInstalled)
        XCTAssertEqual(status(.notInstalled).action, .install)
        XCTAssertEqual(status(.notInstalled, error: "activation failed").action, .install)
        XCTAssertEqual(status(.awaitingApproval, filter: true, proxy: true), .needsApproval)
        XCTAssertEqual(status(.awaitingApproval).action, .openSettings)
        XCTAssertEqual(status(.disabled, filter: true, proxy: true, connection: .disconnected), .turnedOffInSettings,
                       "activated but switched off in System Settings")
        XCTAssertEqual(status(.disabled).action, .openSettings)
        XCTAssertEqual(status(.uninstalling), .notInstalled)
        XCTAssertEqual(status(.unknown, error: "cannot read"), .error("cannot read"))
        XCTAssertEqual(status(.unknown, error: "cannot read").action, .install)
        for state in [status(.notInstalled), status(.awaitingApproval), status(.disabled), status(.uninstalling), status(.unknown, error: "x")] {
            XCTAssertFalse(state.isRunning, "\(state)")
            XCTAssertFalse(state.isProtectionOn, "\(state)")
        }
    }

    func testOffStartingAndHalfwayStatesSayWhichHalfIsOn() {
        XCTAssertEqual(status(.enabled, filter: false, proxy: false, connection: .disconnected), .off)
        XCTAssertEqual(status(.enabled), .off, "installed, never configured")
        XCTAssertEqual(status(.enabled).action, .turnOn)
        XCTAssertEqual(status(.enabled, filter: true, proxy: true, connection: .connecting), .starting)
        XCTAssertEqual(status(.enabled, filter: true, proxy: true, connection: .reasserting), .starting)
        XCTAssertEqual(status(.enabled, filter: true, proxy: false), .partlyOn("content filter on, transparent proxy off"))
        XCTAssertEqual(status(.enabled, filter: true, proxy: true, connection: .disconnected),
                       .partlyOn("content filter on, transparent proxy not running: disconnected"))
        XCTAssertEqual(status(.enabled, filter: false, proxy: true, connection: .connected), .partlyOn("transparent proxy on, content filter off"))
        XCTAssertEqual(status(.enabled, filter: false, proxy: true, connection: .disconnected),
                       .partlyOn("content filter off, transparent proxy not connected"))
        XCTAssertEqual(status(.enabled, filter: true, proxy: false).action, .turnOff)
        XCTAssertEqual(status(.enabled, filter: true, proxy: false, error: "transparent proxy not saved: denied"),
                       .error("transparent proxy not saved: denied"))
        XCTAssertEqual(status(.enabled, filter: false, proxy: false, error: "filter not saved: denied"), .error("filter not saved: denied"))
        for state in [status(.enabled, filter: true, proxy: true, connection: .connecting), status(.enabled, filter: true, proxy: false)] {
            XCTAssertTrue(state.isRunning, "\(state)")
            XCTAssertFalse(state.isProtectionOn, "\(state)")
        }
    }

    func testAStoppedTunnelIsRestartedWithOnePress() {
        let stopped = status(.enabled, filter: true, proxy: true, connection: .disconnected)
        XCTAssertEqual(stopped.action, .turnOn)
        XCTAssertTrue(stopped.isRunning, "the filter half still runs and is still fed")
        XCTAssertEqual(status(.enabled, filter: true, proxy: true, connection: .invalid).action, .turnOn)
        XCTAssertEqual(status(.enabled, filter: true, proxy: false).action, .turnOff, "a proxy switched off is not a stopped tunnel")
        XCTAssertEqual(status(.enabled, filter: false, proxy: true, connection: .connected).action, .turnOff)
    }

    func testThePanelLineNeverClaimsMoreThanMacOSReported() {
        XCTAssertEqual(status(.notInstalled).text, "Not installed")
        XCTAssertEqual(status(.awaitingApproval).text,
                       "Waiting for approval in System Settings → General → Login Items & Extensions → Network Extensions")
        XCTAssertEqual(status(.disabled).text, "Turned off in System Settings → General → Login Items & Extensions → Network Extensions")
        XCTAssertEqual(status(.enabled).text, "Off")
        XCTAssertEqual(status(.enabled, filter: true, proxy: true, connection: .connecting).text, "Starting…")
        XCTAssertEqual(status(.enabled, filter: true, proxy: false).text, "Partly on: content filter on, transparent proxy off")
        XCTAssertEqual(status(.unknown, error: "cannot read").text, "Problem: cannot read")
        XCTAssertFalse(status(.enabled, filter: true, proxy: false).text.hasPrefix("On"))
        XCTAssertFalse(status(.disabled, filter: true, proxy: true, connection: .connected).text.hasPrefix("On"))
    }

    func testOnlyTheSystemApplicationsFolderAndItsSubfoldersCount() {
        XCTAssertEqual(AppLocation.systemApplications.pathComponents, ["/", "Applications"], "the button opens the system folder")
        // isDirectory: true on every path, so no case reads the disk of the machine the test runs on.
        func bundle(_ path: String) -> URL { URL(fileURLWithPath: path, isDirectory: true) }
        for path in ["/Applications/VibtraGuard.app",
                     "/Applications/Utilities/VibtraGuard.app",
                     "/applications/VibtraGuard.app"] {
            XCTAssertTrue(AppLocation.isInSystemApplications(bundle(path)), path)
        }
        for path in ["/Volumes/Vibtra Guard/VibtraGuard.app",
                     "/Users/ada/Downloads/VibtraGuard.app",
                     "/Users/ada/Applications/VibtraGuard.app",
                     "/private/var/folders/ab/xyz/T/AppTranslocation/1234-ABCD/d/VibtraGuard.app",
                     "/ApplicationsX/VibtraGuard.app",
                     "/Applications/../private/tmp/VibtraGuard.app",
                     "/Applications"] {
            XCTAssertFalse(AppLocation.isInSystemApplications(bundle(path)), path)
        }
    }

    func testACopyOutsideApplicationsSaysToMoveItAndKeepsTheButtonItWasPressedOn() {
        func refused(_ systemExtension: ExtensionSnapshot.SystemExtension, filter: Bool? = nil, proxy: Bool? = nil,
                     connection: ExtensionSnapshot.ProxyConnection = .invalid, installed: String? = nil,
                     bundled: String? = nil) -> ExtensionStatus {
            ExtensionStatus.from(ExtensionSnapshot(systemExtension: systemExtension, filterEnabled: filter, proxyEnabled: proxy,
                                                   proxyConnection: connection, installedVersion: installed,
                                                   bundledVersion: bundled, notInApplications: true))
        }
        let notInstalled = refused(.notInstalled)
        XCTAssertEqual(notInstalled, .notInApplications(.notInstalled))
        XCTAssertEqual(notInstalled.text, "Move Vibtra Guard to the Applications folder, then open it from there.")
        XCTAssertEqual(notInstalled.action, .install, "the button stays live, so pressing it explains again")
        XCTAssertFalse(notInstalled.isRunning, "nothing is installing")
        XCTAssertFalse(notInstalled.isProtectionOn)

        let off = refused(.enabled)
        XCTAssertEqual(off.action, .turnOn, "the button keeps the title the person pressed")
        XCTAssertEqual(off.text, AppLocation.moveToApplications)

        let update = refused(.enabled, filter: true, proxy: true, connection: .connected, installed: "30", bundled: "31")
        XCTAssertEqual(update.action, .update)
        XCTAssertTrue(update.isProtectionOn, "the extension this Mac already installed still protects it")
        XCTAssertTrue(update.isRunning, "documents are still pushed to the extension that runs")
        XCTAssertEqual(update.text, AppLocation.moveToApplications, "the sentence replaces the state, the update line included")
    }

    func testMacOSRefusingWhereTheAppLivesReadsAsTheMoveSentenceAndOtherFailuresStayVerbatim() {
        let refused = NSError(domain: "OSSystemExtensionErrorDomain", code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "The system extension's parent bundle location is unsupported"])
        XCTAssertTrue(ActivationFailure(refused).notInApplications)
        XCTAssertEqual(ActivationFailure(refused).text,
                       "The system extension's parent bundle location is unsupported (OSSystemExtensionErrorDomain 3)",
                       "the raw text still reaches the log")
        let others = [(NSError(domain: "OSSystemExtensionErrorDomain", code: 2, userInfo: [NSLocalizedDescriptionKey: "missing entitlement"]),
                       "missing entitlement (OSSystemExtensionErrorDomain 2)"),
                      (NSError(domain: "OSSystemExtensionErrorDomain", code: 8, userInfo: [NSLocalizedDescriptionKey: "code signature invalid"]),
                       "code signature invalid (OSSystemExtensionErrorDomain 8)"),
                      (NSError(domain: "NEVPNErrorDomain", code: 3, userInfo: [NSLocalizedDescriptionKey: "configuration stale"]),
                       "configuration stale (NEVPNErrorDomain 3)")]
        for (error, line) in others {
            XCTAssertFalse(ActivationFailure(error).notInApplications, "\(error.domain) \(error.code)")
            XCTAssertEqual(ActivationFailure(error).text, line, "code 3 in another domain is another error")
        }
    }

    func testTheMoveAlertAnswersEveryPressAndInterruptsOncePerLaunchOnItsOwn() {
        var gate = AppLocationAlert()
        let byItself = [gate.shouldShow(for: .automatic), gate.shouldShow(for: .automatic), gate.shouldShow(for: .automatic)]
        let thenPressed = [gate.shouldShow(for: .person), gate.shouldShow(for: .person)]
        XCTAssertEqual(byItself, [true, false, false], "a link, a poll or a refused request interrupts once a launch")
        XCTAssertEqual(thenPressed, [true, true], "a press always gets an answer")
        var pressedFirst = AppLocationAlert()
        let order = [pressedFirst.shouldShow(for: .person), pressedFirst.shouldShow(for: .automatic)]
        XCTAssertEqual(order, [true, true], "a press does not spend the one automatic alert")
    }
}
