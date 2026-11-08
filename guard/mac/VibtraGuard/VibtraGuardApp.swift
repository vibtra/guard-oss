// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import AppKit
import SwiftUI

@main
struct VibtraGuardApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @ObservedObject private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra(isInserted: $model.menuBarShown) {
            StatusPanel(model: model)
        } label: {
            Image(nsImage: menuBarMark)
                .opacity(model.status == nil ? 0.5 : 1)
                .accessibilityLabel(menuLabel)
                .help(menuLabel)
        }
        .menuBarExtraStyle(.window)
    }

    private var menuBarMark: NSImage {
        let image = NSImage(named: "VibtraMark")?.copy() as? NSImage ?? NSImage()
        image.size = NSSize(width: 16, height: 16)
        image.isTemplate = true
        return image
    }

    private var menuLabel: String {
        if model.status == nil { return "Vibtra Guard, agent not reachable" }
        return model.status?.clientMode == "enforce" ? "Vibtra Guard, enforcing" : "Vibtra Guard, monitoring"
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            NSApp.setActivationPolicy(.accessory)
            if CommandLine.arguments.contains("--remove-extension") {
                removeExtensionAndExit()
                return
            }
            AppModel.shared.start()
            Task { @MainActor in
                await Self.replaceOtherCopies()
                AppModel.shared.caSigner.start()
                defer { AppModel.shared.launchResolved = true }
                if case .success(let status) = await AgentClient.status() {
                    if let pid = status.pid, AgentPaths.isAgentProcess(pid) { AppModel.shared.supervisor.adopt(pid: pid) }
                    return
                }
                if AgentPaths.binaryPresent { AppModel.shared.supervisor.start() }
            }
        }
    }

    @MainActor private static func replaceOtherCopies() async {
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0.processIdentifier != getpid() }
        let removing = UserDefaults.standard.integer(forKey: AppModel.removingPidKey)
        if others.contains(where: { Int($0.processIdentifier) == removing }) { exit(0) }
        others.forEach { $0.forceTerminate() }
        let deadline = Date().addingTimeInterval(5)
        while others.contains(where: { !$0.isTerminated }) && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    @MainActor private func removeExtensionAndExit() {
        UserDefaults.standard.set(Int(getpid()), forKey: AppModel.removingPidKey)
        AppModel.shared.extensionController.uninstall { result in
            UserDefaults.standard.removeObject(forKey: AppModel.removingPidKey)
            switch result {
            case .removed:
                print("The network extension was removed.")
                exit(0)
            case .afterRestart:
                print("Restart this Mac to finish removing the network extension.")
                exit(3)
            case .failed(let why):
                FileHandle.standardError.write(Data("The network extension was not removed: \(why)\n".utf8))
                exit(1)
            }
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        MainActor.assumeIsolated {
            for url in urls where url.scheme == "vibtra-guard" {
                AppModel.shared.menuBarShown = true
                switch url.host {
                case "enrol":
                    WindowManager.shared.showEnrol(prefill: EnrolLink.parse(url.absoluteString))
                case "status":
                    AppModel.shared.reopen()
                case "install-extension":
                    AppModel.shared.extensionController.activate()
                    WindowManager.shared.showStatus()
                case "enable-extension":
                    AppModel.shared.extensionController.turnOn()
                case "disable-extension":
                    #if DEBUG
                    AppModel.shared.extensionController.turnOff()
                    #else
                    WindowManager.shared.showStatus()
                    #endif
                default:
                    break
                }
            }
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        MainActor.assumeIsolated {
            let model = AppModel.shared
            let event = NSAppleEventManager.shared().currentAppleEvent
            let systemQuit = (event?.attributeDescriptor(forKeyword: kAEQuitReason) ?? event?.paramDescriptor(forKeyword: kAEQuitReason)) != nil
            guard !model.terminating, !systemQuit, model.guardRunning else { return .terminateNow }
            model.quit()
            return .terminateCancel
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { AppModel.shared.supervisor.release() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        MainActor.assumeIsolated { AppModel.shared.reopen() }
        return true
    }
}
