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

    public init(systemExtension: SystemExtension = .unknown, filterEnabled: Bool? = nil, proxyEnabled: Bool? = nil, proxyConnection: ProxyConnection = .invalid, error: String? = nil, installedVersion: String? = nil, bundledVersion: String? = nil) {
        self.systemExtension = systemExtension
        self.filterEnabled = filterEnabled
        self.proxyEnabled = proxyEnabled
        self.proxyConnection = proxyConnection
        self.error = error
        self.installedVersion = installedVersion
        self.bundledVersion = bundledVersion
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

    public static func from(_ s: ExtensionSnapshot) -> ExtensionStatus {
        let protection = protectionState(s)
        if s.systemExtension == .enabled,
           let installed = s.installedVersion, !installed.isEmpty,
           let bundled = s.bundledVersion, !bundled.isEmpty, installed != bundled {
            return .updateAvailable(installed: installed, bundled: bundled, protection: protection, error: s.error)
        }
        return protection
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
        if filterOn && proxyOn && proxyUp { return .on }
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
        }
    }

    public var isProtectionOn: Bool {
        if case let .updateAvailable(_, _, protection, _) = self { return protection.isProtectionOn }
        return self == .on
    }

    public var isRunning: Bool {
        switch self {
        case let .updateAvailable(_, _, protection, _): return protection.isRunning
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
        case .checking: return .none
        case .notInstalled, .error: return .install
        case .needsApproval, .turnedOffInSettings: return .openSettings
        case .off: return .turnOn
        case .partlyOn(let what) where what.hasPrefix(Self.proxyStoppedPrefix): return .turnOn
        case .on, .starting, .partlyOn: return .turnOff
        }
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
