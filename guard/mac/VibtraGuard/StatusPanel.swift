// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import AppKit
import SwiftUI

struct StatusPanel: View {
    @ObservedObject var model: AppModel
    var inMenu = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Divider()
            if model.binaryMissing {
                notice("agent binary missing: build guard/agent", systemImage: "exclamationmark.triangle")
            }
            if let s = model.status {
                facts(s)
                if s.clientMode == "enforce" {
                    counts(s.today)
                } else {
                    monitorCounts(s.today)
                }
            } else {
                notice(model.statusError.map { "Agent not reachable on 127.0.0.1:9471: \($0)" } ?? "Checking the agent…", systemImage: "bolt.horizontal.circle")
                row("Network extension", model.extensionStatus.text).font(.callout)
            }
            Divider()
            actions
        }
        .padding(14)
        .frame(width: 320)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image("VibtraMark").renderingMode(.template).resizable().scaledToFit()
                .frame(width: 24, height: 24).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Vibtra Guard").font(.headline)
                Text(agentLine).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let mode = model.status?.clientMode {
                Text(mode == "enforce" ? "Enforce" : "Monitor")
                    .font(.callout.weight(.semibold))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(mode == "enforce" ? Color.red.opacity(0.15) : Color.secondary.opacity(0.15)))
            }
        }
    }

    private var agentLine: String {
        if model.status != nil, model.agentState == .missingBinary || model.agentState == .stopped {
            return "agent answering on 127.0.0.1:9471 (not started by this app)"
        }
        switch model.agentState {
        case .missingBinary: return "agent binary missing"
        case .stopped: return "agent stopped"
        case .starting: return "agent starting…"
        case .running(let pid): return "agent running (pid \(pid))"
        case .backingOff(let s, let code): return "agent exited (\(code)); restarting in \(s) s"
        }
    }

    private func facts(_ s: AgentStatus) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if s.enrolled {
                row("Person", s.personName.map { "\($0) · \(s.personEmail ?? "")" } ?? s.personEmail ?? "Not known")
                row("Organisation", s.orgName ?? s.orgHandle ?? "Not known")
                row("Last sync", s.lastSyncAt.map(Self.relative) ?? "not yet")
                if let err = s.lastSyncError { row("Sync problem", err) }
            } else {
                notice("Not enrolled. Use Enrol… with the link IT sent you.", systemImage: "person.badge.plus")
            }
            row("Network extension", model.extensionStatus.text)
        }
        .font(.callout)
    }

    private func counts(_ c: GuardCounts) -> some View {
        HStack(spacing: 8) {
            countBox("Allowed", c.allowed, .green)
            countBox("Blocked", c.blocked, .red)
            countBox("Asked", c.asked, .orange)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Today: \(c.allowed) allowed, \(c.blocked) blocked, \(c.asked) asked")
    }

    private func monitorCounts(_ c: GuardCounts) -> some View {
        HStack(spacing: 8) {
            countBox("Would allow", c.wouldAllow, .green)
            countBox("Would block", c.wouldBlocked, .red)
            countBox("Would ask", c.wouldAsked, .orange)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Today in Monitor: \(c.wouldAllow) would be allowed, \(c.wouldBlocked) would be blocked, \(c.wouldAsked) would be asked")
    }

    private func countBox(_ label: String, _ value: Int, _ tint: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(value)").font(.title3.monospacedDigit().weight(.semibold))
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 8).fill(tint.opacity(0.08)))
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 2) {
            menuButton("Open web dashboard", "globe") { model.openConsole() }
                .disabled(!model.consoleAvailable)
            menuButton("Enrol…", "person.badge.key") { WindowManager.shared.showEnrol(prefill: nil) }
            menuButton("Trust the Guard certificate", "checkmark.seal") { model.trustCertificate() }
            menuButton("Trust for command-line tools…", "terminal") { model.trustForCommandLineTools() }
                .disabled(model.binaryMissing)
            menuButton(model.agentRunning ? "Stop agent" : "Start agent", model.agentRunning ? "stop.circle" : "play.circle") { model.toggleAgent() }
                .disabled(model.binaryMissing || (model.status != nil && !model.agentRunning))
            menuButton("Open block page", "hand.raised") { model.openLastBlockPage() }
                .disabled(model.lastBlocked == nil && model.status?.lastBlockedEventId == nil)
            if let (title, image) = extensionAction {
                menuButton(title, image) { model.extensionController.performPanelAction() }
            }
            menuButton("Open agent log", "doc.text") { NSWorkspace.shared.open(AgentPaths.agentLog) }
            Divider().padding(.vertical, 4)
            menuButton(model.removing ? "Removing Guard…" : "Remove Guard…", "trash") { model.removeGuard() }
                .disabled(model.removing)
            menuButton("Quit Vibtra Guard", "power") {
                model.supervisor.stop()
                NSApp.terminate(nil)
            }
        }
    }

    private var extensionAction: (String, String)? {
        switch model.extensionStatus.action {
        case .update: return ("Update network extension", "arrow.triangle.2.circlepath")
        case .install: return ("Install network extension", "network.badge.shield.half.filled")
        case .turnOn: return ("Turn on network protection", "network.badge.shield.half.filled")
        case .turnOff: return ("Turn off network protection", "network.slash")
        case .openSettings: return ("Open Network Extensions settings", "gearshape")
        case .none: return nil
        }
    }

    private func menuButton(_ title: String, _ image: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: image).frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(MenuRowButtonStyle())
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary).frame(minWidth: 110, alignment: .leading).fixedSize()
            Text(value).lineLimit(4).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }

    private func notice(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage).font(.callout).foregroundStyle(.secondary)
    }

    static func relative(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }
        if abs(date.timeIntervalSinceNow) < 10 { return "just now" }
        return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
    }
}

private struct MenuRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        MenuRow(configuration: configuration)
    }

    private struct MenuRow: View {
        let configuration: ButtonStyle.Configuration
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false

        var body: some View {
            let lit = hovering && isEnabled
            configuration.label
                .foregroundStyle(lit ? AnyShapeStyle(Color.white) : isEnabled ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .padding(.vertical, 3)
                .padding(.horizontal, 6)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(Color.accentColor.opacity(configuration.isPressed ? 0.75 : 1))
                        .opacity(lit ? 1 : 0)
                )
                .contentShape(Rectangle())
                .onContinuousHover { phase in
                    switch phase {
                    case .active:
                        hovering = true
                        if isEnabled { NSCursor.pointingHand.set() }
                    case .ended:
                        hovering = false
                        NSCursor.arrow.set()
                    }
                }
                .onChange(of: isEnabled) { _, enabled in
                    if !enabled { resetHover() }
                }
                .onReceive(NotificationCenter.default.publisher(for: NSWindow.didResignKeyNotification)) { _ in
                    resetHover()
                }
                .padding(.horizontal, -6)
        }

        private func resetHover() {
            if hovering { NSCursor.arrow.set() }
            hovering = false
        }
    }
}
