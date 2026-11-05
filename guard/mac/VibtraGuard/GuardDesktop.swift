// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import AppKit
import SwiftUI

enum GuardPane: String, CaseIterable, Identifiable {
    case overview = "Overview", activity = "Activity", rules = "Rules", setup = "Setup"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .overview: return "shield.lefthalf.filled"
        case .activity: return "waveform.path"
        case .rules: return "checklist"
        case .setup: return "slider.horizontal.3"
        }
    }
    var subtitle: String {
        switch self {
        case .overview: return "AI use and protection on this Mac."
        case .activity: return "Recent decisions from this agent. Prompt contents stay out of this history."
        case .rules: return "Your organisation’s rules, as received and verified by this Mac."
        case .setup: return "Connect this Mac and choose how your apps send traffic through Guard."
        }
    }
}

struct GuardDesktop: View {
    @ObservedObject var model: AppModel
    @ObservedObject var chrome: GuardWindowChrome
    @State private var pane: GuardPane? = .overview

    init(model: AppModel, chrome: GuardWindowChrome, initialPane: GuardPane = .overview) {
        self.model = model
        self.chrome = chrome
        _pane = State(initialValue: initialPane)
    }

    var body: some View {
        GeometryReader { viewport in
            navigation.frame(width: viewport.size.width, height: viewport.size.height)
        }
    }

    private var navigation: some View {
        NavigationSplitView(columnVisibility: $chrome.sidebarVisibility) {
            VStack(alignment: .leading, spacing: 0) {
                Label {
                    Text("Vibtra Guard")
                } icon: {
                    Image("VibtraMark").renderingMode(.template).resizable().scaledToFit()
                        .frame(width: 20, height: 20).accessibilityHidden(true)
                }
                    .font(.headline).padding(.horizontal, 20).padding(.vertical, 24)
                List(GuardPane.allCases, selection: $pane) { item in
                    Label(item.rawValue, systemImage: item.icon).tag(item)
                }.listStyle(.sidebar).scrollContentBackground(.hidden).frame(maxHeight: .infinity)
                Divider()
                VStack(alignment: .leading, spacing: 5) {
                    Text(model.status?.orgName ?? "This Mac").font(.callout.weight(.medium))
                    Text(model.status?.personEmail ?? "Enrol with the link from IT")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2).textSelection(.enabled)
                }.padding(20)
            }.frame(maxHeight: .infinity)
                .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 250)
                .toolbar(removing: .sidebarToggle)
        } detail: {
            GeometryReader { viewport in
                detail.frame(width: viewport.size.width, height: viewport.size.height, alignment: .topLeading)
            }
        }.navigationSplitViewStyle(.balanced)
            .toolbar(removing: .sidebarToggle)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await model.refresh() } } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .help("Refresh agent status, activity and rules")
                    .accessibilityIdentifier("guard.refresh")
                }
            }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text((pane ?? .overview).rawValue).font(.title.weight(.semibold))
                    Text((pane ?? .overview).subtitle).font(.callout).foregroundStyle(.secondary)
                        .lineLimit(2, reservesSpace: true)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }.padding(.bottom, 20)
            Divider().padding(.bottom, 24)
            if let error = model.statusError {
                Label("Agent unavailable: \(error)", systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.orange).padding(.bottom, 16)
            } else if let error = model.desktopError {
                Label(error, systemImage: "exclamationmark.triangle").font(.callout).padding(.bottom, 16)
            }
            switch pane ?? .overview {
            case .overview: GuardOverview(model: model, showSetup: { pane = .setup }, showActivity: { pane = .activity })
            case .activity: GuardActivity(model: model)
            case .rules: GuardRules(model: model)
            case .setup: GuardSetup(model: model)
            }
        }
        .frame(maxWidth: 960, maxHeight: .infinity, alignment: .topLeading)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct GuardOverview: View {
    @ObservedObject var model: AppModel
    let showSetup: () -> Void
    let showActivity: () -> Void

    private var title: String {
        guard let status = model.status else { return "Waiting for the agent" }
        if status.revoked { return "This device’s access was revoked" }
        if !status.enrolled { return "Connect this Mac to your organisation" }
        if status.bundleVersion == nil { return "Waiting for your organisation’s rules" }
        if !status.proxyListening { return "The inspection proxy is stopped" }
        if model.extensionStatus.isProtectionOn { return status.clientMode == "enforce" ? "Network protection is on" : "Monitoring AI use" }
        return "Ready for apps configured to use the proxy"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                GroupBox {
                    HStack(alignment: .top, spacing: 16) {
                        Image(systemName: model.extensionStatus.isProtectionOn ? "checkmark.shield.fill" : "shield.lefthalf.filled")
                            .font(.system(size: 30)).foregroundStyle(model.extensionStatus.isProtectionOn ? Color.green : Color.accentColor)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 8) {
                            Text(title).font(.title3.weight(.semibold))
                            Text(model.status?.clientMode == "monitor"
                                 ? "Monitor mode records what rules would block. Requests continue to the AI service."
                                 : "Guard applies your organisation’s service and content rules to traffic routed through this agent.")
                                .foregroundStyle(.secondary)
                            Button("Review setup", action: showSetup)
                        }
                        Spacer(minLength: 0)
                    }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                }
                Text("Today on this agent").font(.headline)
                HStack(spacing: 12) {
                    GuardMetric(title: "Allowed / observed", count: (model.status?.today.allowed ?? 0) + (model.status?.today.observed ?? 0), icon: "checkmark.circle", tint: .green)
                    GuardMetric(title: model.status?.clientMode == "monitor" ? "Would block" : "Blocked", count: model.status?.today.blocked ?? 0, icon: "hand.raised", tint: .orange)
                    GuardMetric(title: model.status?.clientMode == "monitor" ? "Would ask" : "Needs approval", count: model.status?.today.asked ?? 0, icon: "person.crop.circle.badge.questionmark", tint: .blue)
                }
                GroupBox("Protection details") {
                    VStack(spacing: 12) {
                        GuardFact(label: "Network protection", value: model.extensionStatus.text)
                        GuardFact(label: "Certificate trust", value: model.status?.caTrusted.map { $0 ? "Trusted on this Mac" : "Not trusted — finish Setup" } ?? "Not verified")
                        GuardFact(label: "Policy", value: model.policy?.bundleVersion.map { "Version \($0) · \(model.policy?.contentRules.count ?? 0) content rules" } ?? "Waiting for a verified policy")
                        GuardFact(label: "Last sync", value: model.status?.lastSyncAt.map(StatusPanel.relative) ?? "Not yet")
                        if let error = model.status?.lastSyncError { GuardFact(label: "Sync problem", value: error) }
                    }.padding(12).frame(maxWidth: .infinity)
                }
                HStack {
                    Text("Counts are decisions since this agent started today. Repeated page requests may be grouped.")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("View activity", action: showActivity)
                }
                Text("Content checks cover supported text, JSON, forms and text attachments up to 4 MB. Compressed bodies, binary files and WebSocket messages are outside content inspection. Activity identifies requests that received only a service check.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .topLeading)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct GuardMetric: View {
    let title: String
    let count: Int
    let icon: String
    let tint: Color
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Image(systemName: icon).foregroundStyle(tint).accessibilityHidden(true)
                Text(count, format: .number).font(.largeTitle.monospacedDigit().weight(.semibold))
                Text(title).font(.callout).foregroundStyle(.secondary)
            }.padding(10).frame(maxWidth: .infinity, minHeight: 112, alignment: .leading)
        }.accessibilityElement(children: .combine)
    }
}

private struct GuardActivity: View {
    @ObservedObject var model: AppModel
    @State private var query = ""
    @State private var filter = "all"

    private var events: [DecisionEvent] {
        model.activity.filter { event in
            let matches = query.isEmpty || [event.serviceName, event.host, event.ruleName, event.appName].compactMap { $0 }
                .contains { $0.localizedCaseInsensitiveContains(query) }
            let selected = filter == "all" || (filter == "blocked" && ["blocked", "asked"].contains(event.action))
                || (filter == "unchecked" && event.inspection?.state == "flow-only" && event.inspection?.reason != "no-request-body")
            return matches && selected
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                TextField("Search services, apps or rules", text: $query).textFieldStyle(.roundedBorder)
                Picker("Show activity", selection: $filter) {
                    Text("All").tag("all")
                    Text("Blocks / asks").tag("blocked")
                    Text("Unchecked bodies").tag("unchecked")
                }.frame(width: 175)
            }
            if events.isEmpty {
                ContentUnavailableView(query.isEmpty && filter == "all" ? "No recent activity" : "No matching decisions",
                                       systemImage: "waveform.path",
                                       description: Text("Decisions appear when an enrolled agent checks traffic routed through Guard."))
            } else {
                List(events) { event in
                    GuardActivityRow(event: event) {
                        WindowManager.shared.showBlocked(event)
                    }.listRowSeparator(.visible)
                }.listStyle(.inset).scrollContentBackground(.hidden)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipShape(.rect(cornerRadius: 10))
            }
            HStack(spacing: 8) {
                Image(systemName: model.streamConnected ? "dot.radiowaves.left.and.right" : "arrow.clockwise")
                Text(model.streamConnected ? "Live updates" : "Reconnecting to live updates")
                Spacer()
                Text("\(events.count) shown · latest 300 kept on this Mac")
            }.font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct GuardActivityRow: View {
    let event: DecisionEvent
    let showBlock: () -> Void
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            BrandMarkTile(content: BrandMarkContent.service(id: event.serviceId), size: 30)
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(event.serviceName ?? event.host ?? "AI service").font(.headline)
                    GuardAction(action: event.action, monitor: event.enforced == false)
                }
                Text([event.appName, event.ruleName ?? event.ruleId, event.inspection?.label, event.inspection?.categoryLabel].compactMap { $0 }.joined(separator: " · "))
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let host = event.host { Text(host).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 8) {
                if let date = event.occurredAt { Text(StatusPanel.relative(date)).font(.caption).foregroundStyle(.secondary) }
                if event.shouldPopUp { Button("Details", action: showBlock).controlSize(.small) }
            }
        }.padding(.vertical, 8)
    }
}

private struct GuardRules: View {
    @ObservedObject var model: AppModel
    @State private var query = ""
    private func matching(_ rules: [LocalPolicy.Rule]) -> [LocalPolicy.Rule] {
        rules.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || ($0.note?.localizedCaseInsensitiveContains(query) == true) }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top) {
                    Label("Managed by your organisation", systemImage: "building.2.crop.circle").font(.headline)
                    Spacer()
                    Button("Open rules in console") { model.openConsole(page: "rules") }.disabled(!model.consoleAvailable)
                }
                Text("Service rules below include active service exceptions. Content rules show their assigned scope; temporary access grants can permit specific requests. IT manages rules and grants in the console.")
                    .font(.callout).foregroundStyle(.secondary)
                if let policy = model.policy, policy.available {
                    if policy.mode == "monitor" {
                        Label("Monitor mode: these rules record decisions without blocking requests.", systemImage: "eye")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(policy.warnings ?? [], id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange)
                    }
                    TextField("Find a rule or service", text: $query).textFieldStyle(.roundedBorder)
                    if !query.isEmpty && matching(policy.contentRules).isEmpty && matching(policy.services).isEmpty {
                        ContentUnavailableView.search(text: query)
                    } else {
                        GuardRuleGroup(title: "Content rules", rules: matching(policy.contentRules), empty: "No content rules to show.")
                        GuardRuleGroup(title: "AI services", rules: matching(policy.services), empty: "No services to show.")
                    }
                } else {
                    ContentUnavailableView("No verified policy yet", systemImage: "checklist", description: Text("Enrol this Mac and let the agent sync with your organisation."))
                }
            }.frame(maxWidth: .infinity, alignment: .topLeading)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct GuardRuleGroup: View {
    let title: String
    let rules: [LocalPolicy.Rule]
    let empty: String
    var body: some View {
        GroupBox(title) {
            LazyVStack(alignment: .leading, spacing: 0) {
                if rules.isEmpty { Text(empty).foregroundStyle(.secondary).padding(12) }
                ForEach(rules) { rule in
                    GuardRuleRow(rule: rule)
                    if rule.id != rules.last?.id { Divider().padding(.horizontal, 12) }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct GuardRuleRow: View {
    let rule: LocalPolicy.Rule
    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Text(rule.name).font(.callout.weight(.medium))
                if rule.source == "exception" { Text("Temporary access grant").font(.caption).foregroundStyle(.secondary) }
                if let services = rule.serviceNames {
                    Text(services.count == 1 ? services[0] : "\(services.count) AI services")
                        .font(.caption).foregroundStyle(.secondary).help(services.joined(separator: ", "))
                }
                if let note = rule.note { Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer()
            GuardAction(action: rule.action)
        }.padding(12)
    }
}

private struct GuardSetup: View {
    @ObservedObject var model: AppModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                GroupBox("1. Connect your organisation") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(model.status?.enrolled == true ? "Enrolled as \(model.status?.personEmail ?? "your account")" : "Use the enrolment link your IT team sent you.")
                        Button(model.status?.enrolled == true ? "Enrol another account…" : "Enrol this Mac…") { WindowManager.shared.showEnrol(prefill: nil) }
                    }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                }
                GroupBox("2. Trust this Mac’s Guard certificate") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Guard creates a certificate unique to this Mac to inspect enabled AI services. macOS asks you to approve trust.")
                            .foregroundStyle(.secondary)
                        Label(model.status?.caTrusted == true ? "Certificate trusted" : "Certificate trust not verified", systemImage: model.status?.caTrusted == true ? "checkmark.seal" : "seal")
                        HStack {
                            Button("Trust certificate…") { model.trustCertificate() }.disabled(model.binaryMissing)
                            Button("Trust for command-line tools…") { model.trustForCommandLineTools() }.disabled(model.binaryMissing)
                        }
                    }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                }
                GroupBox("3. Route AI traffic through Guard") {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Network protection covers supported apps without per-app proxy settings. macOS may ask you to approve the extension.")
                            .foregroundStyle(.secondary)
                        GuardFact(label: "Network protection", value: model.extensionStatus.text)
                        if model.extensionStatus.action != .none {
                            Button(model.extensionStatus.action.title) { model.extensionController.performPanelAction() }
                        }
                        DisclosureGroup("Manual browser or terminal setup") {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("For a selected client, use HTTP and HTTPS proxy 127.0.0.1:9470. Command-line tools also need the certificate exports from step 2. Remove proxy settings before stopping Guard.")
                                    .foregroundStyle(.secondary)
                                HStack {
                                    Button("Copy proxy exports") { model.copyProxyEnvironment() }
                                    Text("Only copies commands; your settings stay in your control.").font(.caption).foregroundStyle(.secondary)
                                }
                            }.padding(.top, 12)
                        }
                    }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                }
                GroupBox("Agent") {
                    HStack {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(model.status?.proxyListening == true ? "Proxy listening on this Mac" : "Proxy not confirmed running").font(.headline)
                            Text("Stopping the agent makes network steering fall back to direct connections. Manually configured clients need their proxy settings removed.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if model.agentRunning || model.status == nil {
                            Button(model.agentRunning ? "Stop agent" : "Start agent") { model.toggleAgent() }.disabled(model.binaryMissing)
                        } else {
                            Text("Started outside this app").font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(12)
                }
                Text("Only catalogued AI domains are decrypted. Prompt contents are evaluated in memory and are never added to this app’s activity history.")
                    .font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .topLeading)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct GuardFact: View {
    let label: String
    let value: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(label).foregroundStyle(.secondary).frame(width: 135, alignment: .leading)
            Text(value).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        }.font(.callout).accessibilityElement(children: .combine)
    }
}

private struct GuardAction: View {
    let action: String
    var monitor = false
    private var tint: Color {
        if monitor { return .secondary }
        switch action {
        case "allow", "allowed": return .green
        case "block", "blocked": return .red
        case "ask", "asked", "requested": return .orange
        default: return .secondary
        }
    }
    private var title: String {
        if monitor && ["blocked", "asked"].contains(action) { return action == "blocked" ? "Would block" : "Would ask" }
        return ["allow": "Allow", "block": "Block", "ask": "Ask", "allowed": "Allowed", "observed": "Observed",
                "blocked": "Blocked", "asked": "Needs approval", "requested": "Access requested", "redirected": "Workspace opened"][action] ?? action.capitalized
    }
    var body: some View {
        Text(title).font(.caption.weight(.medium)).fixedSize()
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(tint.opacity(0.13), in: Capsule())
    }
}

private extension ExtensionStatus.Action {
    var title: String {
        switch self {
        case .update: return "Update network extension…"
        case .install: return "Install network extension…"
        case .turnOn: return "Turn on network protection"
        case .turnOff: return "Turn off network protection"
        case .openSettings: return "Open Network Extensions settings"
        case .none: return "Network protection"
        }
    }
}
