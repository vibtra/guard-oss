// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import Network

final class SocketFlow: RelayClientFlow {
    let connection: NWConnection
    private var endPending = false

    init(_ connection: NWConnection) { self.connection = connection }

    func open(_ completion: @escaping (Error?) -> Void) { completion(nil) }

    func readData(_ completion: @escaping (Data?, Error?) -> Void) {
        if endPending {
            completion(nil, nil)
            return
        }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [self] data, _, done, error in
            if let data, !data.isEmpty {
                if done { endPending = true }
                completion(data, nil)
            } else if let error {
                completion(nil, error)
            } else if done {
                completion(nil, nil)
            } else {
                readData(completion)
            }
        }
    }

    func write(_ data: Data, _ completion: @escaping (Error?) -> Void) {
        connection.send(content: data, completion: .contentProcessed { completion($0) })
    }

    func close(_ error: Error?) { connection.cancel() }
}
