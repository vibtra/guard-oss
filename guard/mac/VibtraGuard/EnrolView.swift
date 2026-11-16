// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import SwiftUI

struct EnrolView: View {
    @ObservedObject var model: AppModel
    @State var linkOrToken: String
    @State var server: String
    @State private var running = false
    @State private var output = ""
    @State private var exitCode: Int32?
    @State private var linkProblem: String?
    @State private var serverProblem: String?
    @State private var registry: BuiltInRegistry?
    @State private var registryProblem: String?
    var close: () -> Void

    init(model: AppModel, prefill: EnrolLink?, close: @escaping () -> Void) {
        self.model = model
        _linkOrToken = State(initialValue: prefill?.token ?? "")
        _server = State(initialValue: prefill?.server ?? "")
        self.close = close
    }

    private var parsed: EnrolLink {
        let link = EnrolLink.parse(linkOrToken)
        let typedServer = server.trimmingCharacters(in: .whitespacesAndNewlines)
        return EnrolLink(server: typedServer.isEmpty ? link.server : typedServer, token: link.token)
    }

    private var serverValid: Bool {
        guard let s = parsed.server, let url = URL(string: s), let scheme = url.scheme else { return false }
        return (scheme == "https" || scheme == "http") && url.host != nil
    }

    private var builtIn: (server: String?, problem: String?)? {
        guard let registry, registry.fixed else { return nil }
        return registry.server(asked: EnrolLink.parse(linkOrToken).server ?? (server.isEmpty ? nil : server))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Enrol this Mac").font(.title2.weight(.semibold))
            Text("Paste the enrol link your IT team sent you. It connects this Mac to your organisation's Vibtra Guard; Guard only looks at traffic to AI services.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 6) {
                Text("Enrol link or token").font(.callout.weight(.medium))
                TextField("Enrol link or token", text: $linkOrToken, prompt: Text("vibtra-guard://enrol?server=…&token=genr_…"))
                    .textFieldStyle(.roundedBorder)
                    .labelsHidden()
                    .onChange(of: linkOrToken) { _, newValue in
                        if let s = EnrolLink.parse(newValue).server, server.isEmpty { server = s }
                        linkProblem = nil
                    }
                if let problem = linkProblem ?? ((!linkOrToken.isEmpty && parsed.token == nil) ? Self.notALink : nil) {
                    problemLine(problem)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Server").font(.callout.weight(.medium))
                if let builtIn {
                    if let fixed = builtIn.server ?? registry?.origin {
                        Text(fixed).font(.callout.monospaced()).textSelection(.enabled)
                        Text("This copy of Guard enrols only with this server.").font(.caption).foregroundStyle(.secondary)
                    }
                    if let problem = builtIn.problem { problemLine(problem) }
                } else if let registryProblem {
                    problemLine(registryProblem)
                } else {
                    TextField("Server", text: $server, prompt: Text("https://vibtra.app"))
                        .textFieldStyle(.roundedBorder)
                        .labelsHidden()
                        .onChange(of: server) { _, _ in serverProblem = nil }
                    if let serverProblem { problemLine(serverProblem) }
                }
            }
            if model.binaryMissing {
                Label {
                    Text("agent binary missing: build guard/agent")
                } icon: {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                }
            }
            if !output.isEmpty || running {
                ScrollView {
                    Text(running ? "Enrolling…" : output)
                        .font(.system(.callout, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(height: 120)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.08)))
                if let exitCode {
                    Label {
                        Text(exitCode == 0 ? "Enrolled." : "Enrolment failed (exit \(exitCode)).")
                    } icon: {
                        Image(systemName: exitCode == 0 ? "checkmark.circle" : "xmark.octagon")
                            .foregroundStyle(exitCode == 0 ? .green : .red)
                    }
                }
            }
            HStack {
                Spacer()
                Button(exitCode == 0 ? "Done" : "Cancel", action: close).keyboardShortcut(.cancelAction)
                Button("Enrol") { enrol() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(running || model.binaryMissing || exitCode == 0 || registry == nil || builtIn?.problem != nil)
            }
        }
        .padding(20)
        .frame(width: 480)
        .task {
            let (code, out) = await AgentSupervisor.runOnce(["registry"])
            registry = code == 0 ? BuiltInRegistry.parse(Data(out.utf8)) : nil
            if registry == nil && !model.binaryMissing { registryProblem = "Guard could not tell which server it may enrol with. Reinstall Guard from your IT team." }
        }
        .onChange(of: registry) { _, _ in WindowManager.shared.refit() }
        .onChange(of: registryProblem) { _, _ in WindowManager.shared.refit() }
        .onChange(of: running) { _, _ in WindowManager.shared.refit() }
        .onChange(of: exitCode) { _, _ in WindowManager.shared.refit() }
        .onChange(of: linkProblem) { _, _ in WindowManager.shared.refit() }
        .onChange(of: serverProblem) { _, _ in WindowManager.shared.refit() }
        .onChange(of: parsed.token == nil && !linkOrToken.isEmpty) { _, _ in WindowManager.shared.refit() }
    }

    private static let notALink = "That is not an enrol link or a token (genr_ followed by 32 characters)."

    private func problemLine(_ text: String) -> some View {
        Label {
            Text(text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
        }
        .font(.callout)
    }

    private func enrol() {
        if parsed.token == nil {
            let problem = linkOrToken.isEmpty ? "Paste the enrol link or token IT sent you." : Self.notALink
            linkProblem = problem
            AccessibilityNotification.Announcement(problem).post()
            return
        }
        if let builtIn {
            if let problem = builtIn.problem {
                AccessibilityNotification.Announcement(problem).post()
                return
            }
        } else if !serverValid {
            let problem = "Enter the server address, starting https://"
            serverProblem = problem
            AccessibilityNotification.Announcement(problem).post()
            return
        }
        guard let token = parsed.token, let server = builtIn?.server ?? parsed.server else { return }
        running = true
        exitCode = nil
        Task {
            let (code, out) = await AgentSupervisor.runOnce(["enrol", "--server", server, "--token", token])
            await MainActor.run {
                running = false
                exitCode = code
                output = out.isEmpty ? "(no output)" : out
                AccessibilityNotification.Announcement(code == 0 ? "Enrolled." : "Enrolment failed (exit \(code)).").post()
            }
            if code == 0 {
                model.startGuard()
                await model.refresh()
            }
        }
    }
}
