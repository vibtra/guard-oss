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
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
        return library.appendingPathComponent("Logs/Vibtra Guard", isDirectory: true)
    }

    static var agentLog: URL { logDir.appendingPathComponent("agent.log") }
}
