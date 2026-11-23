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
    /// macOS will not load the extension from where this copy of the app is. Set when a request was refused,
    /// never cleared by a read of the configurations: only a relaunch from the right folder clears it.
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
    /// macOS will not load the extension from where the app is, so `AppLocation.moveToApplications` replaces the
    /// line. It carries the state underneath, so the button keeps the title the person pressed and a Mac that is
    /// still protected still says so.
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

/// Where macOS insists the app lives before it loads the app's system extension, and the words that say so.
///
/// `OSSystemExtensionManager` refuses an activation request from a bundle outside `/Applications` with
/// `OSSystemExtensionError.unsupportedParentBundleLocation`. The app asks this before it sends the request, so
/// someone who opened Guard from the disk image, from Downloads or from `~/Applications` reads one sentence
/// instead of an error code. Guard never moves, copies or deletes itself: only the person moves the app.
public enum AppLocation {
    /// What the person has to do. The one copy of this sentence: the alert's title and the status line both read it.
    public static let moveToApplications = "Move Vibtra Guard to the Applications folder, then open it from there."
    /// Why macOS asks for it.
    public static let whyApplications = "macOS only turns on network protection when Guard is in Applications."
    /// The alert's first button, which opens the folder in Finder.
    public static let openApplicationsFolder = "Open Applications folder"
    /// The alert's second button, which only closes it.
    public static let notNow = "Not now"

    /// The system Applications folder. `~/Applications` does not count.
    public static let systemApplications = URL(fileURLWithPath: "/Applications", isDirectory: true)

    /// Whether `bundleURL` sits in the system Applications folder, a subfolder of it included: macOS loads a
    /// system extension from, say, `/Applications/Utilities/VibtraGuard.app`.
    ///
    /// The path is standardized lexically, so no answer depends on the disk the check runs on:
    /// `standardizedFileURL` drops `.` and `..` segments without reading the filesystem, which is why
    /// `/Applications/../private/tmp/VibtraGuard.app` fails. The comparison is per path component, so
    /// `/ApplicationsX/…`, `/Users/…/Applications/…` and a translocated `/private/var/folders/…` fail too. The
    /// caller resolves symlinks on the real bundle before asking.
    ///
    /// Case is ignored, because the system volume ignores it. A path that passes here and that macOS still
    /// refuses reaches the same sentence through `ActivationFailure.notInApplications`, while a path refused
    /// here by mistake would leave the person no way forward.
    public static func isInSystemApplications(_ bundleURL: URL) -> Bool {
        let components = bundleURL.standardizedFileURL.pathComponents
        guard components.count > 2, components[0] == "/" else { return false }
        return components[1].caseInsensitiveCompare("Applications") == .orderedSame
    }
}

/// What a failed `OSSystemExtensionRequest` means for the person.
///
/// It matches the domain and the code as plain values because this file is also built into the network
/// extension, which does not link SystemExtensions. `ExtensionController` asserts both against the framework's
/// own symbols, so a renamed symbol fails the build rather than this check.
public struct ActivationFailure: Equatable, Sendable {
    /// `OSSystemExtensionErrorDomain`.
    public static let errorDomain = "OSSystemExtensionErrorDomain"
    /// `OSSystemExtensionError.Code.unsupportedParentBundleLocation`: the app is not in `/Applications`.
    public static let unsupportedParentBundleLocation = 3

    /// macOS refused the request over where the app lives, so the person reads `AppLocation.moveToApplications`
    /// and never the error text.
    public let notInApplications: Bool
    /// The error as one line, for the log and for the states that do show the raw text.
    public let text: String

    public init(_ error: Error) {
        let ns = error as NSError
        notInApplications = ns.domain == Self.errorDomain && ns.code == Self.unsupportedParentBundleLocation
        text = "\(ns.localizedDescription) (\(ns.domain) \(ns.code))"
    }
}

/// Who asked for the network extension.
public enum ExtensionRequestTrigger: Equatable, Sendable {
    /// The person pressed the button in the panel or in the Guard window.
    case person
    /// The app asked by itself, through a `vibtra-guard://` link or after macOS refused a request.
    case automatic
}

/// How often the move-to-Applications alert interrupts. The caller shows the alert; this only decides.
public struct AppLocationAlert: Equatable, Sendable {
    private var askedAutomatically = false

    public init() {}

    /// Whether to put the alert on screen now. A press always gets an answer. The automatic path gets one alert
    /// per launch, so a misplaced copy does not interrupt on every link, poll or refused request.
    public mutating func shouldShow(for trigger: ExtensionRequestTrigger) -> Bool {
        guard trigger == .automatic else { return true }
        guard !askedAutomatically else { return false }
        askedAutomatically = true
        return true
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
