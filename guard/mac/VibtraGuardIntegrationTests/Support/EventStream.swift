// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation

final class EventStream: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var parser = SSEParser()
    private var line = Data()
    private var received: [SSEParser.Message] = []
    private var bytes = 0
    private var status = 0
    private var session: URLSession?
    private var task: URLSessionDataTask?

    init(url: URL) {
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3600
        config.timeoutIntervalForResource = 86_400
        config.connectionProxyDictionary = [:]
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let task = session.dataTask(with: request)
        self.session = session
        self.task = task
        task.resume()
    }

    var messages: [SSEParser.Message] { lock.withLock { received } }
    var isPrimed: Bool { lock.withLock { status == 200 && bytes > 0 } }

    func decisions() -> [DecisionEvent] {
        messages.filter { $0.event == "decision" }.compactMap { DecisionEvent.parse($0.data) }
    }

    func waitForDecision(_ limit: TimeInterval = 10, where match: (DecisionEvent) -> Bool) -> DecisionEvent? {
        var found: DecisionEvent?
        Wait.until(limit) {
            found = decisions().first(where: match)
            return found != nil
        }
        return found
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.withLock { status = (response as? HTTPURLResponse)?.statusCode ?? 0 }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        defer { lock.unlock() }
        bytes += data.count
        for byte in data {
            if byte == 0x0A {
                if let message = parser.feed(String(decoding: line, as: UTF8.self)) { received.append(message) }
                line.removeAll(keepingCapacity: true)
            } else {
                line.append(byte)
            }
        }
    }

    func close() {
        task?.cancel()
        session?.invalidateAndCancel()
    }
}
