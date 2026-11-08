// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation

enum AgentPaths {
    static var binary: URL {
        if let override = ProcessInfo.processInfo.environment["VIBTRA_GUARD_AGENT_BIN"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/vibtra-guard")
    }

    static var binaryPresent: Bool {
        FileManager.default.isExecutableFile(atPath: binary.path)
    }

    static func isAgentProcess(_ pid: Int32) -> Bool {
        var name = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &name, UInt32(name.count)) > 0 else { return false }
        return String(cString: name) == binary.lastPathComponent
    }

    static var binaryIdentity: String? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: binary.path),
              let inode = attributes[.systemFileNumber],
              let modified = attributes[.modificationDate] as? Date else { return nil }
        return "\(inode):\(modified.timeIntervalSince1970)"
    }

    static var dataDir: URL {
        if let override = ProcessInfo.processInfo.environment["VIBTRA_GUARD_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return support.appendingPathComponent("Vibtra Guard", isDirectory: true)
    }

    static var bundleFile: URL { dataDir.appendingPathComponent("bundle.json") }
    static var relayAttributionPin: URL { dataDir.appendingPathComponent("relay-attribution.json") }
    static var catalogueFile: URL { dataDir.appendingPathComponent("catalogue.json") }
    static var extensionEventsInbox: URL { dataDir.appendingPathComponent("events-from-extension.jsonl") }

    static var logDir: URL {
        if let override = ProcessInfo.processInfo.environment["VIBTRA_GUARD_LOG_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
        return library.appendingPathComponent("Logs/Vibtra Guard", isDirectory: true)
    }

    static var agentLog: URL { logDir.appendingPathComponent("agent.log") }
}
