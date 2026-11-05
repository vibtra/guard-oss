// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import AppKit
import SwiftUI

struct BlockedView: View {
    @ObservedObject var model: AppModel
    let decision: DecisionEvent
    var close: () -> Void
    @State private var note = ""
    @State private var requesting = false
    @State private var requestError: String?
    @State private var pollTask: Task<Void, Never>?

    private var asked: Bool { decision.action == "asked" }
    private var askStatus: String? { model.askStatuses[decision.eventId] }
    private var service: String { decision.serviceName ?? decision.serviceId ?? decision.host ?? "an AI service" }
    private var requestsEnabled: Bool { decision.requestsEnabled ?? model.status?.requestsEnabled ?? true }
    private var workspaceURL: URL? {
        let enabled = decision.workspaceEnabled ?? model.status?.workspaceEnabled ?? false
        guard enabled, let raw = decision.workspaceUrl ?? model.status?.workspaceUrl else { return nil }
        return URL(string: raw)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Image(systemName: asked ? "hand.raised.fill" : "xmark.shield.fill")
                    .font(.largeTitle)
                    .foregroundStyle(asked ? .orange : .red)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(asked ? "This needs IT's OK" : "Blocked").font(.title2.weight(.semibold))
                    Text(headline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                facts
                Button("Open the full details") { NSWorkspace.shared.open(AgentClient.blockPage(eventId: decision.eventId)) }
                    .buttonStyle(.link)
                    .font(.callout)
            }
            if requestsEnabled { requestSection }
            HStack {
                if let workspaceURL {
                    Button("Use the company Vibtra workspace") { NSWorkspace.shared.open(workspaceURL); close() }
                }
                Spacer()
                Button("Close", action: close).keyboardShortcut(.cancelAction)
                if requestsEnabled && askStatus == nil {
                    Button(requesting ? "Requesting…" : "Request access") { request() }
                        .buttonStyle(.borderedProminent)
                        .disabled(requesting)
                }
            }
        }
        .padding(20)
        .frame(minWidth: 420, idealWidth: 460, maxWidth: 560)
        .onDisappear { pollTask?.cancel() }
        .onChange(of: askStatus) { _, status in
            if let status { AccessibilityNotification.Announcement(Self.askWords(status)).post() }
            WindowManager.shared.refit()
        }
        .onChange(of: requestError) { _, _ in WindowManager.shared.refit() }
    }

    private var headline: String {
        if let rule = decision.ruleName, decision.matchType != nil {
            return "Your organisation's rule “\(rule)” stops this from being sent to \(service)."
        }
        return "Your organisation does not allow \(service) on this Mac."
    }

    private var facts: some View {
        VStack(alignment: .leading, spacing: 4) {
            fact("Service", service, mark: .service(id: decision.serviceId))
            if let rule = decision.ruleName ?? decision.ruleId { fact("Rule", rule) }
            if let type = decision.matchType {
                fact("Found", "\(Self.matchWords(type))\(decision.matchCount.map { " · \($0) occurrence(s)" } ?? "")")
            }
            if let example = decision.example { fact("Example", example) }
            if let app = decision.appName { fact("App", app, mark: .app(app)) }
        }
        .font(.callout)
        .fixedSize(horizontal: false, vertical: true)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
    }

    @ViewBuilder private var requestSection: some View {
        if let status = askStatus {
            Label {
                Text(Self.askWords(status)).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: status == "approved" ? "checkmark.circle" : status == "pending" ? "clock" : "info.circle")
                    .foregroundStyle(status == "approved" ? .green : .secondary)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("Why you need it (optional)").font(.callout.weight(.medium))
                TextField("Why you need it", text: $note, prompt: Text("IT sees this line"))
                    .textFieldStyle(.roundedBorder)
                    .labelsHidden()
                if let requestError {
                    Label {
                        Text(requestError).fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                    }
                    .font(.callout)
                }
            }
        }
    }

    private func fact(_ label: String, _ value: String, mark: BrandMarkContent? = nil) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary).frame(minWidth: 70, alignment: .leading).fixedSize()
            if let mark { BrandMarkTile(content: mark, size: 18).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 } }
            Text(value).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func request() {
        requesting = true
        requestError = nil
        let eventId = decision.eventId
        Task {
            let result = await AgentClient.requestAccess(eventId: eventId, note: note)
            await MainActor.run {
                requesting = false
                switch result {
                case .success(let status): model.askStatuses[eventId] = status; startPolling()
                case .failure(let error):
                    requestError = error.localizedDescription
                    AccessibilityNotification.Announcement(error.localizedDescription).post()
                }
            }
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        let eventId = decision.eventId
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if let s = await AgentClient.askStatus(eventId: eventId) {
                    await MainActor.run { model.askStatuses[eventId] = s }
                    if s != "pending" { return }
                }
                let current = await MainActor.run { model.askStatuses[eventId] }
                if let current, current != "pending" { return }
            }
        }
    }

    static func askWords(_ status: String) -> String {
        switch status {
        case "pending": return "Waiting for IT. You can close this window; Guard lets you know."
        case "approved": return "IT approved it. Try again; it goes through after the next sync (within a minute)."
        case "declined": return "IT declined the request."
        case "expired": return "The request expired."
        case "cancelled": return "The request was cancelled."
        default: return "Request \(status)."
        }
    }

    static func matchWords(_ type: String) -> String {
        switch type {
        case "au-tfn": return "a tax file number"
        case "au-abn": return "an ABN"
        case "au-acn": return "an ACN"
        case "au-medicare": return "a Medicare number"
        case "card-number": return "a card number"
        case "identifiers": return "a personal identifier"
        case "secret": return "a secret or API key"
        case "email-bulk": return "many email addresses"
        case "phone-bulk": return "many phone numbers"
        case "keyword": return "a blocked keyword"
        case "file-type": return "a blocked file type"
        default: return type
        }
    }
}
