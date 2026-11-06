// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    @Published var status: AgentStatus?
    @Published var statusError: String?
    @Published var lastChecked: Date?
    @Published var agentState: AgentSupervisor.State = .stopped
    @Published var streamConnected = false
    @Published var extensionStatus: ExtensionStatus = .checking
    @Published var lastBlocked: DecisionEvent?
    @Published var askStatuses: [String: String] = [:]
    @Published var activity: [DecisionEvent] = []
    @Published var policy: LocalPolicy?
    @Published var desktopError: String?

    let supervisor = AgentSupervisor()
    let caSigner = CASigner(store: SecureEnclaveKeyStore.app, directory: AgentPaths.dataDir)
    let extensionController = ExtensionController()
    let notifier = BlockNotifier()
    @Published var removing = false
    private var pollTask: Task<Void, Never>?
    private var streamTask: Task<Void, Never>?
    private var started = false
    private var refreshing = false

    var binaryMissing: Bool { !AgentPaths.binaryPresent }

    func start() {
        guard !started else { return }
        started = true
        supervisor.onChange = { [weak self] state in self?.agentState = state }
        extensionController.onStatus = { [weak self] s in self?.extensionStatus = s }
        extensionController.startObserving()
        notifier.start()
        if binaryMissing { agentState = .missingBinary }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
        streamTask = Task { [weak self] in await self?.streamLoop() }
    }

    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        let result = await AgentClient.status()
        lastChecked = Date()
        extensionController.poll()
        extensionController.drainEvents()
        switch result {
        case .success(let s):
            status = s
            statusError = nil
            do {
                async let currentPolicy = AgentClient.policy()
                async let recent = AgentClient.activity()
                let (policy, events) = try await (currentPolicy, recent)
                self.policy = policy
                mergeActivity(events)
                desktopError = nil
            } catch {
                policy = nil
                desktopError = "Activity and rules could not be refreshed. Restart the agent after updating Guard."
            }
        case .failure(let e):
            status = nil
            policy = nil
            statusError = e.localizedDescription
        }
    }

    private func streamLoop() async {
        var wait: UInt64 = 1
        while !Task.isCancelled {
            do {
                try await AgentClient.streamEvents(
                    onOpen: { await MainActor.run { AppModel.shared.streamConnected = true } },
                    onMessage: { message in await MainActor.run { AppModel.shared.handle(message) } }
                )
                wait = 1
            } catch {
            }
            streamConnected = false
            try? await Task.sleep(nanoseconds: wait * 1_000_000_000)
            wait = min(wait * 2, 30)
        }
    }

    func handle(_ message: SSEParser.Message) {
        switch message.event {
        case "decision":
            guard let decision = DecisionEvent.parse(message.data) else { return }
            mergeActivity([decision])
            if decision.action == "blocked" || decision.action == "asked" { lastBlocked = decision }
            notifier.handle(decision)
        case "synced":
            extensionController.mirrorDocuments()
            Task { await refresh() }
        case "ask-decided":
            if let data = message.data.data(using: .utf8),
               let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                let view = (root["request"] as? [String: Any]) ?? root
                let ev = (root["eventId"] as? String) ?? (view["subject"] as? [String: Any])?["eventId"] as? String
                let st = AgentClient.askStatus(data) ?? "decided"
                if let ev { askStatuses[ev] = st }
            }
        default:
            break
        }
    }

    private func mergeActivity(_ events: [DecisionEvent]) {
        var seen = Set<String>()
        activity = Array((events + activity).filter { seen.insert($0.eventId).inserted }
            .enumerated().sorted {
                let a = $0.element.occurredDate ?? .distantPast
                let b = $1.element.occurredDate ?? .distantPast
                return a == b ? $0.offset < $1.offset : a > b
            }.prefix(300).map(\.element))
    }

    func openConsole(page: String = "") {
        guard let url = GuardConsoleLink.url(server: status?.server, handle: status?.orgHandle, page: page) else { return }
        NSWorkspace.shared.open(url)
    }

    var consoleAvailable: Bool { GuardConsoleLink.url(server: status?.server, handle: status?.orgHandle) != nil }

    func copyProxyEnvironment() {
        let proxy = "http://127.0.0.1:\(GuardConstants.proxyPort)"
        let snippet = "export HTTPS_PROXY=\(CLITrust.shellQuoted(proxy))\nexport HTTP_PROXY=\(CLITrust.shellQuoted(proxy))\nexport NO_PROXY=\"${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1,::1\"\n"
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(snippet, forType: .string)
    }

    func toggleAgent() {
        switch agentState {
        case .running, .starting, .backingOff: supervisor.stop()
        default: supervisor.start()
        }
    }

    var agentRunning: Bool {
        switch agentState {
        case .running, .starting, .backingOff: return true
        default: return false
        }
    }

    func openLastBlockPage() {
        guard let id = lastBlocked?.eventId ?? status?.lastBlockedEventId else { return }
        NSWorkspace.shared.open(AgentClient.blockPage(eventId: id))
    }

    func trustForCommandLineTools() {
        Task {
            let (code, pem) = await AgentSupervisor.runOnce(["ca", "export"])
            guard code == 0, CLITrust.isPEMCertificate(pem) else {
                Self.inform("The Guard certificate could not be exported", pem.isEmpty ? "exit \(code)" : String(pem.suffix(800)))
                return
            }
            let roots = await Self.certificates(in: CLITrust.systemRootsKeychain)
            let adminCAs = await Self.certificates(in: CLITrust.adminKeychain)
            let dir = AgentPaths.dataDir
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try Data(pem.utf8).write(to: dir.appendingPathComponent(CLITrust.caFileName), options: .atomic)
                try Data(CLITrust.bundle(systemRoots: roots, adminCAs: adminCAs, guardCA: pem).utf8).write(to: dir.appendingPathComponent(CLITrust.bundleFileName), options: .atomic)
            } catch {
                Self.inform("The certificate files were not written", error.localizedDescription)
                return
            }
            let snippet = CLITrust.snippet(directory: dir.path)
            let alert = NSAlert()
            alert.messageText = "Trust Guard in command-line tools"
            alert.informativeText = "Command-line tools (Claude Code, the OpenAI and Anthropic SDKs, curl, git, Python) do not read your keychain, so they refuse the Guard certificate on AI services Guard checks. Add these lines to your shell profile (for example ~/.zshrc), then open a new terminal. Guard does not change your shell files.\n\nguard-ca-bundle.pem holds macOS's root certificates, the certificates your administrator trusts on this Mac, and the Guard certificate."
            let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 520, height: 120))
            text.string = snippet
            text.isEditable = false
            text.isSelectable = true
            text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            text.setAccessibilityLabel("Shell lines to add")
            alert.accessoryView = text
            alert.addButton(withTitle: "Copy the lines")
            alert.addButton(withTitle: "Close")
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(snippet, forType: .string)
            }
        }
    }

    nonisolated private static func certificates(in keychain: String) async -> String {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/security")
                p.arguments = ["find-certificate", "-a", "-p", keychain]
                let pipe = Pipe()
                p.standardOutput = pipe
                p.standardError = FileHandle.nullDevice
                do { try p.run() } catch { continuation.resume(returning: ""); return }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                continuation.resume(returning: p.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : "")
            }
        }
    }

    private static func inform(_ title: String, _ body: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    func removeGuard() {
        guard !removing else { return }
        let alert = NSAlert()
        alert.messageText = "Remove Vibtra Guard from this Mac?"
        alert.informativeText = """
        This stops Guard and removes it: the network extension and its routing, the Guard certificate, the agent and \
        Guard's local files. Other certificates and network settings are not changed.

        macOS asks you to approve removing the extension and asks for your password to remove the certificate. It may \
        ask you to restart.

        This Mac stays listed in your organisation until an administrator revokes it in the Guard web dashboard.
        """
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Remove Guard")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        removing = true
        supervisor.stop()
        extensionController.uninstall { [weak self] extensionResult in
            Task { @MainActor in await self?.finishRemoval(extensionResult) }
        }
    }

    private func finishRemoval(_ extensionResult: ExtensionController.RemovalResult) async {
        var lines: [String] = []
        switch extensionResult {
        case .removed: lines.append("The network extension was removed.")
        case .afterRestart: lines.append("Restart this Mac to finish removing the network extension.")
        case .failed(let why): lines.append("The network extension was not removed: \(why). Moving the app to the Trash removes it.")
        }
        do {
            _ = try caSigner.prune(keeping: [])
        } catch {
            lines.append("Guard's certificate key was not deleted from the keychain: \(error).")
        }
        let script = Bundle.main.url(forResource: "uninstall-guard", withExtension: "sh")
        var scriptOK = false
        if let script {
            let (code, output) = await Self.runScript(script)
            scriptOK = code == 0
            if output.contains("Restart this Mac") && !lines.contains(where: { $0.hasPrefix("Restart") }) {
                lines.append("Restart this Mac to finish removing the network extension.")
            }
            if !scriptOK { lines.append("Some steps did not complete:\n" + String(output.suffix(1200))) }
        } else {
            lines.append("The removal script is missing from this copy of the app. See docs/removal.md.")
        }
        var trashed = false
        do {
            try await NSWorkspace.shared.recycle([Bundle.main.bundleURL])
            trashed = true
        } catch {
            lines.append("Move Vibtra Guard to the Trash yourself: \(error.localizedDescription)")
        }
        lines.append("Ask your administrator to revoke this Mac in the Guard web dashboard.")
        let done = NSAlert()
        done.messageText = scriptOK && trashed ? "Vibtra Guard was removed" : "Vibtra Guard was partly removed"
        done.informativeText = lines.joined(separator: "\n\n")
        NSApp.activate(ignoringOtherApps: true)
        done.runModal()
        if let id = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: id) }
        NSApp.terminate(nil)
    }

    nonisolated private static func runScript(_ script: URL) async -> (Int32, String) {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/bin/zsh")
                p.arguments = [script.path, "--yes", "--from-app", "--app", Bundle.main.bundlePath]
                let pipe = Pipe()
                p.standardOutput = pipe
                p.standardError = pipe
                do { try p.run() } catch { continuation.resume(returning: (-1, error.localizedDescription)); return }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                continuation.resume(returning: (p.terminationStatus, String(decoding: data, as: UTF8.self)))
            }
        }
    }

    func trustCertificate() {
        let alert = NSAlert()
        alert.messageText = "Trust the Vibtra Guard certificate"
        alert.informativeText = "Vibtra Guard made a certificate that exists only on this Mac. Trusting it lets Guard check what is sent to AI services (and only AI services) before it leaves.\n\nmacOS will ask for your login password to change your certificate trust settings. Nothing is sent anywhere."
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task {
            let (code, output) = await AgentSupervisor.runOnce(["ca", "trust"])
            let done = NSAlert()
            done.messageText = code == 0 ? "Certificate trusted" : "The certificate was not trusted"
            done.informativeText = output.isEmpty ? "exit \(code)" : String(output.suffix(1500))
            NSApp.activate(ignoringOtherApps: true)
            done.runModal()
            await refresh()
        }
    }
}
