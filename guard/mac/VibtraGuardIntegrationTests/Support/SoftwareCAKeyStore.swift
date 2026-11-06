// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import CryptoKit
import Foundation

final class SoftwareCAKeyStore: CAKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: P256.Signing.PrivateKey] = [:]
    private var failure: CAKeyStoreError?

    func fail(with error: CAKeyStoreError?) { lock.withLock { failure = error } }

    private func locked<T>(_ body: () throws -> T) throws -> T {
        try lock.withLock {
            if let failure { throw failure }
            return try body()
        }
    }

    func keyIDs() throws -> [String] { try locked { keys.keys.sorted() } }

    func create() throws -> (id: String, spki: Data) {
        try locked {
            let key = P256.Signing.PrivateKey()
            let spki = key.publicKey.derRepresentation
            let id = SHA256.hash(data: spki).map { String(format: "%02x", $0) }.joined()
            keys[id] = key
            return (id, spki)
        }
    }

    func publicKey(_ id: String) throws -> Data? { try locked { keys[id]?.publicKey.derRepresentation } }

    func sign(_ id: String, message: Data) throws -> Data? {
        try locked { try keys[id]?.signature(for: message).derRepresentation }
    }

    func delete(keeping: Set<String>) throws -> Int {
        try locked {
            let doomed = keys.keys.filter { !keeping.contains($0) }
            doomed.forEach { keys[$0] = nil }
            return doomed.count
        }
    }
}
