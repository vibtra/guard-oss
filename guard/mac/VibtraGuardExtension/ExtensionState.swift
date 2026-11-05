// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation
import os

final class ExtensionState: NSObject, NSXPCListenerDelegate, GuardExtensionXPC, @unchecked Sendable {
    static let shared = ExtensionState()

    let log = Logger(subsystem: GuardConstants.extensionBundleId, category: "state")
    private let lock = NSLock()
    private var documents = GuardDocumentState()
    private var events: [Data] = []
    private let maxEvents = 5000
    private var listener: NSXPCListener?
    let addresses = HostAddressCache()
    private var catalogueObservers: [(GuardCatalogue) -> Void] = []
    private var resolveTimer: DispatchSourceTimer?
    private let resolveQueue = DispatchQueue(label: GuardConstants.extensionBundleId + ".resolve", qos: .utility)

    func snapshot() -> (GuardBundle?, GuardCatalogue?) {
        lock.lock(); defer { lock.unlock() }
        return (documents.bundle, documents.catalogue)
    }

    @discardableResult
    func load(bundleData: Data?, catalogueData: Data?, source: String) -> String? {
        guard bundleData != nil || catalogueData != nil else { return nil }
        lock.lock()
        do {
            try documents.load(bundleData: bundleData, catalogueData: catalogueData)
        } catch {
            lock.unlock()
            log.error("documents from \(source, privacy: .public) rejected; keeping previous coherent pair")
            return error.localizedDescription
        }
        let newCatalogue = catalogueData == nil ? nil : documents.catalogue
        persist(bundleData: bundleData, catalogueData: catalogueData)
        lock.unlock()
        if let newCatalogue {
            addresses.purge { HostMatcher.isIntercepted(newCatalogue, host: $0) }
            lock.lock(); let observers = catalogueObservers; lock.unlock()
            for observer in observers { observer(newCatalogue) }
            resolveCatalogueHosts(newCatalogue)
        }
        log.info("documents from \(source, privacy: .public): bundle \(bundleData != nil ? "loaded" : "kept", privacy: .public), catalogue \(newCatalogue != nil ? "loaded" : "kept", privacy: .public)")
        return nil
    }

    func load(fromConfiguration config: [String: Any]?, source: String) {
        guard let config else { return }
        load(bundleData: config["bundle"] as? Data, catalogueData: config["catalogue"] as? Data, source: source)
    }

    private var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: GuardConstants.appGroup)
    }

    private func persist(bundleData: Data?, catalogueData: Data?) {
        guard let dir = containerURL else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let bundleData { try? bundleData.write(to: dir.appendingPathComponent("bundle.json"), options: .atomic) }
        if let catalogueData { try? catalogueData.write(to: dir.appendingPathComponent("catalogue.json"), options: .atomic) }
    }

    func loadFromContainer() {
        guard let dir = containerURL else { return }
        let b = try? Data(contentsOf: dir.appendingPathComponent("bundle.json"))
        let c = try? Data(contentsOf: dir.appendingPathComponent("catalogue.json"))
        if b != nil || c != nil { load(bundleData: b, catalogueData: c, source: "app group container") }
    }

    func onCatalogueChange(_ observer: @escaping (GuardCatalogue) -> Void) {
        lock.lock(); catalogueObservers.append(observer); lock.unlock()
    }

    func startResolving() {
        lock.lock()
        let running = resolveTimer != nil
        lock.unlock()
        guard !running else { return }
        let timer = DispatchSource.makeTimerSource(queue: resolveQueue)
        timer.schedule(deadline: .now() + CatalogueResolution.refreshEvery, repeating: CatalogueResolution.refreshEvery)
        timer.setEventHandler { [weak self] in
            guard let self, let catalogue = self.snapshot().1 else { return }
            self.resolveCatalogueHosts(catalogue)
        }
        lock.lock(); resolveTimer = timer; lock.unlock()
        timer.resume()
        if let catalogue = snapshot().1 { resolveCatalogueHosts(catalogue) }
    }

    private func resolveCatalogueHosts(_ catalogue: GuardCatalogue) {
        let hosts = CatalogueResolution.hosts(catalogue)
        resolveQueue.async { [addresses, log] in
            var found = 0
            for host in hosts {
                for address in Self.addresses(of: host) {
                    addresses.record(address: address, host: host, ttl: CatalogueResolution.refreshEvery * 2)
                    found += 1
                }
            }
            log.info("resolved \(hosts.count) catalogue hosts to \(found) addresses (QUIC drop list)")
        }
    }

    static func addresses(of host: String) -> [String] {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        var result: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &result) == 0, let first = result else { return [] }
        defer { freeaddrinfo(first) }
        var out: [String] = []
        var cursor: UnsafeMutablePointer<addrinfo>? = first
        while let ai = cursor {
            var buf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(ai.pointee.ai_addr, ai.pointee.ai_addrlen, &buf, socklen_t(buf.count), nil, 0, NI_NUMERICHOST) == 0 {
                out.append(String(cString: buf))
            }
            cursor = ai.pointee.ai_next
        }
        return out
    }

    func record(_ event: [String: Any]) {
        guard let line = ExtensionEvents.jsonLine(event) else { return }
        lock.lock()
        events.append(line)
        if events.count > maxEvents { events.removeFirst(events.count - maxEvents) }
        lock.unlock()
    }

    func startXPC() {
        let l = NSXPCListener(machServiceName: GuardConstants.extensionMachService)
        l.delegate = self
        l.resume()
        listener = l
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        connection.setCodeSigningRequirement("identifier \"\(GuardConstants.appBundleId)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(GuardConstants.teamId)\"")
        connection.exportedInterface = NSXPCInterface(with: GuardExtensionXPC.self)
        connection.exportedObject = self
        connection.resume()
        return true
    }

    func update(bundle: Data, catalogue: Data, reply: @escaping (String?) -> Void) {
        reply(load(bundleData: bundle.isEmpty ? nil : bundle, catalogueData: catalogue.isEmpty ? nil : catalogue, source: "app (xpc)"))
    }

    func drainEvents(reply: @escaping (Data) -> Void) {
        lock.lock()
        let out = events.reduce(into: Data()) { $0.append($1) }
        events.removeAll()
        lock.unlock()
        reply(out)
    }

    func status(reply: @escaping (String) -> Void) {
        let (b, c) = snapshot()
        lock.lock(); let waiting = events.count; lock.unlock()
        reply("bundle \(b.map { "v\($0.bundleVersion) \($0.clientMode.rawValue)" } ?? "none"), catalogue \(c?.version ?? "none"), \(waiting) events waiting")
    }
}
