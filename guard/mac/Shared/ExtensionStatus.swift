// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation

public struct ExtensionSnapshot: Equatable, Sendable {
    public enum SystemExtension: Equatable, Sendable {
        case unknown
        case notInstalled
        case awaitingApproval
        case disabled
        case enabled
        case uninstalling
    }

    public enum ProxyConnection: String, Equatable, Sendable {
        case invalid, disconnected, connecting, connected, reasserting, disconnecting, unknown
    }

    public var systemExtension: SystemExtension
    public var filterEnabled: Bool?
    public var proxyEnabled: Bool?
    public var proxyConnection: ProxyConnection
    public var error: String?
    public var installedVersion: String?
    public var bundledVersion: String?
    public var policyRefusal: String?
    public var notInApplications: Bool

    public init(systemExtension: SystemExtension = .unknown, filterEnabled: Bool? = nil, proxyEnabled: Bool? = nil, proxyConnection: ProxyConnection = .invalid, error: String? = nil, installedVersion: String? = nil, bundledVersion: String? = nil, policyRefusal: String? = nil, notInApplications: Bool = false) {
        self.systemExtension = systemExtension
        self.filterEnabled = filterEnabled
        self.proxyEnabled = proxyEnabled
        self.proxyConnection = proxyConnection
        self.error = error
        self.installedVersion = installedVersion
        self.bundledVersion = bundledVersion
        self.policyRefusal = policyRefusal
        self.notInApplications = notInApplications
    }
}

public enum ExtensionStatus: Equatable, Sendable {
    case checking
    case notInstalled
    case needsApproval
    case turnedOffInSettings
    case off
    case starting
    case on
    case partlyOn(String)
    case error(String)
    indirect case updateAvailable(installed: String, bundled: String, protection: ExtensionStatus, error: String? = nil)
    indirect case notInApplications(ExtensionStatus)

    public static func from(_ s: ExtensionSnapshot) -> ExtensionStatus {
        let protection = protectionState(s)
        var state = protection
        if s.systemExtension == .enabled,
           let installed = s.installedVersion, !installed.isEmpty,
           let bundled = s.bundledVersion, !bundled.isEmpty, installed != bundled {
            state = .updateAvailable(installed: installed, bundled: bundled, protection: protection, error: s.error)
        }
        return s.notInApplications ? .notInApplications(state) : state
    }

    private static func protectionState(_ s: ExtensionSnapshot) -> ExtensionStatus {
        switch s.systemExtension {
        case .unknown:
            if let error = s.error { return .error(error) }
            if s.filterEnabled == nil && s.proxyEnabled == nil { return .checking }
        case .notInstalled: return s.error.map(ExtensionStatus.error) ?? .notInstalled
        case .awaitingApproval: return .needsApproval
        case .disabled: return .turnedOffInSettings
        case .uninstalling: return .notInstalled
        case .enabled: break
        }
        let filterOn = s.filterEnabled == true
        let proxyOn = s.proxyEnabled == true
        let proxyUp = s.proxyConnection == .connected
        let proxyComing = s.proxyConnection == .connecting || s.proxyConnection == .reasserting
        if !filterOn && !proxyOn { return s.error.map(ExtensionStatus.error) ?? .off }
        if filterOn && proxyOn && proxyUp { return s.policyRefusal.map { ExtensionStatus.partlyOn("the network extension refused Guard's policy (\($0))") } ?? .on }
        if filterOn && proxyOn && proxyComing { return .starting }
        if let error = s.error { return .error(error) }
        if filterOn && !proxyOn { return .partlyOn("content filter on, transparent proxy off") }
        if !filterOn && proxyOn { return proxyUp ? .partlyOn("transparent proxy on, content filter off") : .partlyOn("content filter off, transparent proxy not connected") }
        return .partlyOn("\(Self.proxyStoppedPrefix)\(s.proxyConnection.rawValue)")
    }

    static let proxyStoppedPrefix = "content filter on, transparent proxy not running: "

    public var text: String {
        switch self {
        case let .updateAvailable(installed, bundled, protection, error):
            return "\(protection.text) · Extension update available (\(installed) → \(bundled))" + (error.map { " · \($0)" } ?? "")
        case .checking: return "Checking…"
        case .notInstalled: return "Not installed"
        case .needsApproval: return "Waiting for approval in System Settings → General → Login Items & Extensions → Network Extensions"
        case .turnedOffInSettings: return "Turned off in System Settings → General → Login Items & Extensions → Network Extensions"
        case .off: return "Off"
        case .starting: return "Starting…"
        case .on: return "On: AI sites go through Guard"
        case .partlyOn(let what): return "Partly on: \(what)"
        case .error(let text): return "Problem: \(text)"
        case .notInApplications: return AppLocation.moveToApplications
        }
    }

    public var isProtectionOn: Bool {
        if case let .updateAvailable(_, _, protection, _) = self { return protection.isProtectionOn }
        if case let .notInApplications(state) = self { return state.isProtectionOn }
        return self == .on
    }

    public var isRunning: Bool {
        switch self {
        case let .updateAvailable(_, _, protection, _): return protection.isRunning
        case let .notInApplications(state): return state.isRunning
        case .on, .starting, .partlyOn: return true
        default: return false
        }
    }

    public enum Action: Equatable, Sendable {
        case install, update, turnOn, turnOff, openSettings, none
        public var turnsOnAfterActivation: Bool { self == .install }
    }

    public var action: Action {
        switch self {
        case .updateAvailable: return .update
        case let .notInApplications(state): return state.action
        case .checking: return .none
        case .notInstalled, .error: return .install
        case .needsApproval, .turnedOffInSettings: return .openSettings
        case .off: return .turnOn
        case .partlyOn(let what) where what.hasPrefix(Self.proxyStoppedPrefix): return .turnOn
        case .on, .starting, .partlyOn: return .turnOff
        }
    }
}

public enum AppLocation {
    public static let moveToApplications = "Move Vibtra Guard to the Applications folder, then open it from there."
    public static let whyApplications = "macOS only turns on network protection when Guard is in Applications."
    public static let openApplicationsFolder = "Open Applications folder"
    public static let notNow = "Not now"

    public static let systemApplications = URL(fileURLWithPath: "/Applications", isDirectory: true)

    public static func refusesRequest(from bundleURL: URL, checksLocation: Bool) -> Bool {
        guard checksLocation else { return false }
        return !isInSystemApplications(bundleURL)
    }

    public static func isInSystemApplications(_ bundleURL: URL) -> Bool {
        var components = bundleURL.standardizedFileURL.pathComponents.map { $0.lowercased() }
        guard components.first == "/" else { return false }
        if components.count > 4, components[1] == "system", components[2] == "volumes", components[3] == "data" {
            components.removeSubrange(1...3)
        }
        guard components.count > 2 else { return false }
        return components[1] == "applications"
    }
}

public struct ActivationFailure: Equatable, Sendable {
    public static let errorDomain = "OSSystemExtensionErrorDomain"
    public static let unsupportedParentBundleLocation = 3

    public let notInApplications: Bool
    public let text: String

    public init(_ error: Error) {
        let ns = error as NSError
        notInApplications = ns.domain == Self.errorDomain && ns.code == Self.unsupportedParentBundleLocation
        text = "\(ns.localizedDescription) (\(ns.domain) \(ns.code))"
    }
}

public enum ExtensionRequestTrigger: Equatable, Sendable {
    case person
    case automatic
}

public struct AppLocationAlert: Equatable, Sendable {
    private var askedAutomatically = false
    private var onScreen = false

    public init() {}

    public mutating func shouldShow(for trigger: ExtensionRequestTrigger) -> Bool {
        guard !onScreen else { return false }
        if trigger == .automatic {
            guard !askedAutomatically else { return false }
            askedAutomatically = true
        }
        onScreen = true
        return true
    }

    public mutating func closed() {
        onScreen = false
    }
}

public enum CLITrust {
    public static let caFileName = "guard-ca.pem"
    public static let bundleFileName = "guard-ca-bundle.pem"

    public static func shellQuoted(_ path: String) -> String {
        "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    public static func snippet(directory: String) -> String {
        let dir = directory.hasSuffix("/") ? String(directory.dropLast()) : directory
        let ca = shellQuoted("\(dir)/\(caFileName)")
        let bundle = shellQuoted("\(dir)/\(bundleFileName)")
        return """
        # Vibtra Guard: let command-line tools trust the Guard certificate (add to ~/.zshrc yourself).
        export NODE_EXTRA_CA_CERTS=\(ca)
        export SSL_CERT_FILE=\(bundle)
        export REQUESTS_CA_BUNDLE=\(bundle)
        export CURL_CA_BUNDLE=\(bundle)
        export GIT_SSL_CAINFO=\(bundle)

        """
    }

    public static let adminKeychain = "/Library/Keychains/System.keychain"
    public static let systemRootsKeychain = "/System/Library/Keychains/SystemRootCertificates.keychain"

    public static func bundle(systemRoots: String, adminCAs: String = "", guardCA: String) -> String {
        let parts = [systemRoots, adminCAs, guardCA]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.joined(separator: "\n") + "\n"
    }

    public static func isPEMCertificate(_ text: String) -> Bool {
        text.contains("-----BEGIN CERTIFICATE-----") && text.contains("-----END CERTIFICATE-----")
    }
}
