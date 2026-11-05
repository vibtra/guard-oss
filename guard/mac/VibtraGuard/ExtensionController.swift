// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import AppKit
import Foundation
@preconcurrency import NetworkExtension
import SystemExtensions

@MainActor
final class ExtensionController: NSObject {
    var onStatus: ((ExtensionStatus) -> Void)?
    private(set) var snapshot = ExtensionSnapshot() { didSet { publish() } }
    private(set) var status: ExtensionStatus = .checking
    private var connection: NSXPCConnection?
    private var observers: [NSObjectProtocol] = []
    private var relayPinRequest = NativeRelayPinRequest()
    private let relayDiagnostics = NativeRelayDiagnostics(component: "app")
    private var activating = false
    private var activationRequestId: ObjectIdentifier?
    private var turnOnAfterActivation = false
    private var deactivationRequestId: ObjectIdentifier?
    private var onRemoved: ((RemovalResult) -> Void)?

    enum RemovalResult: Equatable { case removed, afterRestart, failed(String) }

    func startObserving() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        for name in [Notification.Name.NEFilterConfigurationDidChange, .NEVPNConfigurationChange, .NEVPNStatusDidChange] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.configurationsChanged() }
            })
        }
        refresh()
    }

    func refresh() {
        snapshot.error = nil
        refreshSystemExtension()
        refreshConfigurations()
    }

    func poll() {
        refreshSystemExtension()
        refreshConfigurations()
    }

    private func refreshSystemExtension() {
        let request = OSSystemExtensionRequest.propertiesRequest(forExtensionWithIdentifier: GuardConstants.extensionBundleId, queue: .main)
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    private var configurationReadInFlight = false
    private var configurationReadQueued = false
    private var lastConfigurationRead = Date.distantPast

    private func configurationsChanged() {
        if configurationReadInFlight { configurationReadQueued = true; return }
        let wait = 1.0 - Date().timeIntervalSince(lastConfigurationRead)
        if wait > 0 {
            guard !configurationReadQueued else { return }
            configurationReadQueued = true
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.configurationReadQueued = false
                    if !self.configurationReadInFlight { self.refreshConfigurations() }
                }
            }
            return
        }
        refreshConfigurations()
    }

    func refreshConfigurations() {
        guard !configurationReadInFlight else { configurationReadQueued = true; return }
        configurationReadInFlight = true
        lastConfigurationRead = Date()
        NEFilterManager.shared().loadFromPreferences { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                let filter = NEFilterManager.shared()
                let read: ConfigurationRead
                if let error {
                    read = ConfigurationRead(filterEnabled: nil, error: "content filter: \(error.localizedDescription)")
                } else {
                    read = ConfigurationRead(filterEnabled: filter.providerConfiguration?.filterDataProviderBundleIdentifier == GuardConstants.extensionBundleId ? filter.isEnabled : nil)
                }
                self.refreshProxy(after: read)
            }
        }
    }

    private struct ConfigurationRead {
        var filterEnabled: Bool?
        var error: String?
    }

    private func refreshProxy(after read: ConfigurationRead) {
        NETransparentProxyManager.loadAllFromPreferences { [weak self] managers, error in
            Task { @MainActor in
                guard let self else { return }
                var next = self.snapshot
                next.filterEnabled = read.filterEnabled
                if let message = read.error { next.error = message }
                if let error {
                    next.error = "transparent proxy: \(error.localizedDescription)"
                } else if let manager = Self.ours(managers) {
                    next.proxyEnabled = manager.isEnabled
                    next.proxyConnection = Self.connection(manager.connection.status)
                    self.refreshRelayPin(manager)
                } else {
                    self.relayPinRequest.invalidate()
                    next.proxyEnabled = nil
                    next.proxyConnection = .invalid
                }
                if next != self.snapshot { self.snapshot = next }
                self.configurationReadInFlight = false
                self.lastConfigurationRead = Date()
                if self.configurationReadQueued { self.configurationReadQueued = false; self.configurationsChanged() }
            }
        }
    }

    private func refreshRelayPin(_ manager: NETransparentProxyManager) {
        guard manager.isEnabled, manager.connection.status == .connected,
              (manager.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == GuardConstants.extensionBundleId,
              let session = manager.connection as? NETunnelProviderSession else {
            relayDiagnostics.record(.providerUnavailable)
            relayPinRequest.invalidate()
            return
        }
        if relayPinRequest.hasExpired() { relayDiagnostics.record(.providerReplyExpired) }
        guard let request = relayPinRequest.begin() else { return }
        do {
            try session.sendProviderMessage(NativeRelaySigner.request) { [weak self] data in
                Task { @MainActor in
                    guard let self else { return }
                    guard self.relayPinRequest.accept(request) else { self.relayDiagnostics.record(.providerReplyExpired); return }
                    guard manager.isEnabled, session.status == .connected else { self.relayDiagnostics.record(.providerUnavailable); return }
                    guard let data, (try? NativeRelayPublicPin.decode(data)) != nil else { self.relayDiagnostics.record(.providerReplyInvalid); return }
                    let status = await AgentClient.status()
                    guard session.status == .connected else { self.relayDiagnostics.record(.providerUnavailable); return }
                    guard case let .success(value) = status, value.relayAttributionProtocol == 1,
                          let pin = try? NativeRelayPublicPin.decode(data) else {
                        self.relayDiagnostics.record(.capabilityUnavailable)
                        try? session.sendProviderMessage(Data("guard-relay-disable".utf8))
                        return
                    }
                    guard value.proxyListening else {
                        self.relayDiagnostics.record(.proxyUnavailable)
                        try? session.sendProviderMessage(Data("guard-relay-disable".utf8))
                        return
                    }
                    let file = AgentPaths.relayAttributionPin
                    do {
                        if (try? Data(contentsOf: file)) != data { try data.write(to: file, options: .atomic) }
                        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                    } catch {
                        self.relayDiagnostics.record(.pinWriteFailed)
                        try? session.sendProviderMessage(Data("guard-relay-disable".utf8))
                        return
                    }
                    do {
                        if value.relaySteeringProtocol != 1 {
                            try session.sendProviderMessage(NativeRelaySigner.enableMessage(pin: pin))
                            self.relayDiagnostics.record(.enableSent)
                            return
                        }
                        guard let capabilityRequest = self.relayPinRequest.begin() else { return }
                        try session.sendProviderMessage(NativeRelaySigner.steeringRequest) { [weak self] capability in
                            Task { @MainActor in
                                guard let self else { return }
                                guard self.relayPinRequest.accept(capabilityRequest) else { self.relayDiagnostics.record(.providerReplyExpired); return }
                                guard manager.isEnabled, session.status == .connected else { self.relayDiagnostics.record(.providerUnavailable); return }
                                let steering = value.relaySteeringProtocol == 1 && capability == NativeRelaySigner.steeringSupported
                                do {
                                    try session.sendProviderMessage(NativeRelaySigner.enableMessage(pin: pin, steering: steering))
                                    self.relayDiagnostics.record(.enableSent)
                                } catch { self.relayDiagnostics.record(.providerSendFailed) }
                            }
                        }
                    } catch { self.relayDiagnostics.record(.providerSendFailed); self.relayPinRequest.invalidate() }
                }
            }
        } catch { relayDiagnostics.record(.providerSendFailed); relayPinRequest.invalidate() }
    }

    private static func ours(_ managers: [NETransparentProxyManager]?) -> NETransparentProxyManager? {
        managers?.first { ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == GuardConstants.extensionBundleId }
    }

    private static func connection(_ status: NEVPNStatus) -> ExtensionSnapshot.ProxyConnection {
        switch status {
        case .invalid: return .invalid
        case .disconnected: return .disconnected
        case .connecting: return .connecting
        case .connected: return .connected
        case .reasserting: return .reasserting
        case .disconnecting: return .disconnecting
        @unknown default: return .unknown
        }
    }

    private func publish() {
        let next = ExtensionStatus.from(snapshot)
        let becameRunning = next.isRunning && !status.isRunning
        status = next
        onStatus?(next)
        if becameRunning { mirrorDocuments() }
    }

    func performPanelAction() {
        switch status.action {
        case .install, .update: activate(turnOn: status.action.turnsOnAfterActivation)
        case .turnOn: turnOn()
        case .turnOff: turnOff()
        case .openSettings: openNetworkExtensionSettings()
        case .none: refresh()
        }
    }

    func activate(turnOn: Bool = true) {
        guard !activating else { return }
        activating = true
        turnOnAfterActivation = turnOn
        snapshot.error = nil
        let request = OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier: GuardConstants.extensionBundleId, queue: .main)
        request.delegate = self
        activationRequestId = ObjectIdentifier(request)
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    func openNetworkExtensionSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }

    private func documents() -> [String: Any] {
        var out: [String: Any] = [:]
        if let b = try? Data(contentsOf: AgentPaths.bundleFile) { out["bundle"] = b }
        if let c = try? Data(contentsOf: AgentPaths.catalogueFile) { out["catalogue"] = c }
        return out
    }

    func turnOn() {
        snapshot.error = nil
        let docs = documents()
        let filter = NEFilterManager.shared()
        filter.loadFromPreferences { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                if let error { self.snapshot.error = "content filter: \(error.localizedDescription)"; return }
                let config = NEFilterProviderConfiguration()
                config.filterSockets = true
                config.filterPackets = false
                config.filterDataProviderBundleIdentifier = GuardConstants.extensionBundleId
                config.vendorConfiguration = docs
                filter.providerConfiguration = config
                filter.localizedDescription = "Vibtra Guard"
                filter.isEnabled = true
                filter.saveToPreferences { error in
                    Task { @MainActor in
                        if let error { self.snapshot.error = "content filter not saved: \(error.localizedDescription)"; return }
                        self.turnOnProxy(docs: docs)
                    }
                }
            }
        }
    }

    private func turnOnProxy(docs: [String: Any]) {
        NETransparentProxyManager.loadAllFromPreferences { [weak self] managers, error in
            Task { @MainActor in
                guard let self else { return }
                if let error { self.snapshot.error = "transparent proxy: \(error.localizedDescription)"; return }
                let manager = Self.ours(managers) ?? NETransparentProxyManager()
                let proto = NETunnelProviderProtocol()
                proto.providerBundleIdentifier = GuardConstants.extensionBundleId
                proto.serverAddress = "127.0.0.1:\(GuardConstants.transparentPort)"
                proto.providerConfiguration = docs
                manager.protocolConfiguration = proto
                manager.localizedDescription = "Vibtra Guard"
                manager.isEnabled = true
                manager.saveToPreferences { error in
                    Task { @MainActor in
                        if let error { self.snapshot.error = "transparent proxy not saved: \(error.localizedDescription)"; return }
                        manager.loadFromPreferences { _ in
                            Task { @MainActor in
                                do {
                                    try (manager.connection as? NETunnelProviderSession)?.startTunnel()
                                } catch {
                                    self.snapshot.error = "transparent proxy did not start: \(error.localizedDescription)"
                                }
                                self.refreshConfigurations()
                            }
                        }
                    }
                }
            }
        }
    }

    func turnOff() {
        snapshot.error = nil
        NETransparentProxyManager.loadAllFromPreferences { [weak self] managers, _ in
            Task { @MainActor in
                guard let self else { return }
                if let manager = Self.ours(managers) {
                    manager.connection.stopVPNTunnel()
                    manager.isEnabled = false
                    manager.saveToPreferences { error in
                        Task { @MainActor in if let error { self.snapshot.error = "transparent proxy not turned off: \(error.localizedDescription)" } }
                    }
                }
                let filter = NEFilterManager.shared()
                filter.loadFromPreferences { _ in
                    Task { @MainActor in
                        guard filter.providerConfiguration != nil else { self.refreshConfigurations(); return }
                        filter.isEnabled = false
                        filter.saveToPreferences { error in
                            Task { @MainActor in
                                if let error { self.snapshot.error = "content filter not turned off: \(error.localizedDescription)" }
                                self.refreshConfigurations()
                            }
                        }
                    }
                }
            }
        }
    }

    func uninstall(_ done: @escaping (RemovalResult) -> Void) {
        snapshot.error = nil
        onRemoved = done
        NETransparentProxyManager.loadAllFromPreferences { [weak self] managers, _ in
            Task { @MainActor in
                guard let self else { return }
                guard let proxy = Self.ours(managers) else { self.removeFilterThenExtension(); return }
                proxy.connection.stopVPNTunnel()
                proxy.removeFromPreferences { _ in
                    Task { @MainActor in self.removeFilterThenExtension() }
                }
            }
        }
    }

    private func removeFilterThenExtension() {
        let filter = NEFilterManager.shared()
        filter.loadFromPreferences { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                guard filter.providerConfiguration?.filterDataProviderBundleIdentifier == GuardConstants.extensionBundleId else {
                    self.deactivate()
                    return
                }
                filter.removeFromPreferences { _ in Task { @MainActor in self.deactivate() } }
            }
        }
    }

    private func deactivate() {
        let request = OSSystemExtensionRequest.deactivationRequest(forExtensionWithIdentifier: GuardConstants.extensionBundleId, queue: .main)
        request.delegate = self
        deactivationRequestId = ObjectIdentifier(request)
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    private func finishRemoval(_ result: RemovalResult) {
        deactivationRequestId = nil
        let done = onRemoved
        onRemoved = nil
        done?(result)
        refresh()
    }

    private func proxy() -> GuardExtensionXPC? {
        if connection == nil {
            let c = NSXPCConnection(machServiceName: GuardConstants.extensionMachService, options: [])
            c.remoteObjectInterface = NSXPCInterface(with: GuardExtensionXPC.self)
            c.invalidationHandler = { [weak self] in Task { @MainActor in self?.connection = nil } }
            c.interruptionHandler = { [weak self] in Task { @MainActor in self?.connection = nil } }
            c.resume()
            connection = c
        }
        return connection?.remoteObjectProxyWithErrorHandler { _ in } as? GuardExtensionXPC
    }

    func mirrorDocuments() {
        guard status.isRunning else { return }
        let bundle = try? Data(contentsOf: AgentPaths.bundleFile)
        let catalogue = try? Data(contentsOf: AgentPaths.catalogueFile)
        DispatchQueue.global(qos: .utility).async {
            if let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: GuardConstants.appGroup) {
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                if let bundle { try? bundle.write(to: dir.appendingPathComponent("bundle.json"), options: .atomic) }
                if let catalogue { try? catalogue.write(to: dir.appendingPathComponent("catalogue.json"), options: .atomic) }
            }
        }
        proxy()?.update(bundle: bundle ?? Data(), catalogue: catalogue ?? Data()) { _ in }
        drainEvents()
    }

    func drainEvents() {
        guard status.isRunning else { return }
        proxy()?.drainEvents { data in
            guard !data.isEmpty else { return }
            let url = AgentPaths.extensionEventsInbox
            try? ExtensionInboxWriter.append(data, to: url)
        }
    }
}

extension ExtensionController: OSSystemExtensionRequestDelegate {
    nonisolated func request(_ request: OSSystemExtensionRequest, actionForReplacingExtension existing: OSSystemExtensionProperties, withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        .replace
    }

    nonisolated func request(_ request: OSSystemExtensionRequest, foundProperties properties: [OSSystemExtensionProperties]) {
        let state: ExtensionSnapshot.SystemExtension
        if properties.isEmpty {
            state = .notInstalled
        } else if properties.contains(where: { $0.isEnabled && !$0.isUninstalling }) {
            state = .enabled
        } else if properties.contains(where: { $0.isAwaitingUserApproval && !$0.isUninstalling }) {
            state = .awaitingApproval
        } else if properties.allSatisfy(\.isUninstalling) {
            state = .uninstalling
        } else {
            state = .disabled
        }
        let installed = properties.first(where: { $0.isEnabled && !$0.isUninstalling }) ??
            properties.first(where: { !$0.isUninstalling })
        let version = installed?.bundleVersion
        Task { @MainActor in
            var next = self.snapshot
            next.systemExtension = state
            next.installedVersion = version
            let url = Bundle.main.bundleURL.appendingPathComponent("Contents/Library/SystemExtensions/\(GuardConstants.extensionBundleId).systemextension")
            next.bundledVersion = Bundle(url: url)?.object(forInfoDictionaryKey: "CFBundleVersion") as? String
            self.snapshot = next
        }
    }

    nonisolated func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        Task { @MainActor in self.snapshot.systemExtension = .awaitingApproval }
    }

    nonisolated func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        let id = ObjectIdentifier(request)
        Task { @MainActor in
            if id == self.deactivationRequestId {
                self.finishRemoval(result == .willCompleteAfterReboot ? .afterRestart : .removed)
                return
            }
            guard self.activating, id == self.activationRequestId else { return }
            self.activating = false
            self.activationRequestId = nil
            switch result {
            case .completed:
                self.snapshot.systemExtension = .enabled
                if self.turnOnAfterActivation { self.turnOn() }
            case .willCompleteAfterReboot:
                self.snapshot.error = "installed; takes effect after a restart"
            @unknown default:
                self.snapshot.error = "activation finished (\(result.rawValue))"
            }
            self.turnOnAfterActivation = false
            self.refreshSystemExtension()
        }
    }

    nonisolated func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        let ns = error as NSError
        let text = "\(ns.localizedDescription) (\(ns.domain) \(ns.code))"
        NSLog("Vibtra Guard: system extension request failed: %@", text)
        let id = ObjectIdentifier(request)
        Task { @MainActor in
            if id == self.deactivationRequestId {
                self.finishRemoval(.failed(text))
                return
            }
            if self.activating, id == self.activationRequestId {
                self.activating = false
                self.activationRequestId = nil
                self.turnOnAfterActivation = false
                self.snapshot.error = "installing failed: \(text)"
            } else if self.snapshot.systemExtension == .unknown {
                self.snapshot.error = "cannot read the extension's state: \(text)"
            }
        }
    }
}
