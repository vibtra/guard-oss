// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import CryptoKit
import Foundation
import Security
import os

enum CallerVerdict: Equatable {
    case ours(token: Data), unsigned, otherCode
}

private func peerAuditToken(fd: Int32) -> Data? {
    var token = audit_token_t()
    var length = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) == 0, Int(length) == MemoryLayout<audit_token_t>.size else { return nil }
    return withUnsafeBytes(of: &token) { Data($0) }
}

func isOurAgent(fd: Int32, requirement text: String?) -> CallerVerdict {
    guard let tokenData = peerAuditToken(fd: fd) else { return .otherCode }
    var code: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit: tokenData] as CFDictionary, SecCSFlags(), &code) == errSecSuccess,
          let code else { return .otherCode }
    var requirement: SecRequirement?
    if let text, SecRequirementCreateWithString(text as CFString, SecCSFlags(), &requirement) == errSecSuccess,
       let requirement, SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess {
        return .ours(token: tokenData)
    }
    var staticCode: SecStaticCode?
    var info: CFDictionary?
    guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode,
          SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let values = info as? [String: Any] else { return .unsigned }
    return values[kSecCodeInfoTeamIdentifier as String] is String ? .otherCode : .unsigned
}

private func bindCaller(_ connection: LineConnection, fd: Int32, token: Data) -> Bool {
    var nonce = Data(count: 32)
    guard nonce.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { return false }
    let encoded = nonce.base64EncodedString()
    guard connection.write("nonce " + encoded), case .some(.some(let hello)) = connection.read(), hello == "hello " + encoded else { return false }
    return stillBound(connection, fd: fd, token: token)
}

private func stillBound(_ connection: LineConnection, fd: Int32, token: Data) -> Bool {
    !connection.hasUnreadBytes && peerAuditToken(fd: fd) == token
}

func agentRequirement() -> String? {
    var me: SecCode?
    var staticMe: SecStaticCode?
    var info: CFDictionary?
    guard SecCodeCopySelf(SecCSFlags(), &me) == errSecSuccess, let me,
          SecCodeCopyStaticCode(me, SecCSFlags(), &staticMe) == errSecSuccess, let staticMe,
          SecCodeCopySigningInformation(staticMe, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let values = info as? [String: Any],
          let team = values[kSecCodeInfoTeamIdentifier as String] as? String,
          let identifier = values[kSecCodeInfoIdentifier as String] as? String else { return nil }
    return "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and identifier \"\(identifier).agent\""
}

enum CAKeyStoreError: Error, Equatable {
    case noSecureEnclave
    case keychain(OSStatus)
}

protocol CAKeyStore {
    func keyIDs() throws -> [String]
    func create() throws -> (id: String, spki: Data)
    func publicKey(_ id: String) throws -> Data?
    func sign(_ id: String, message: Data) throws -> Data?
    func delete(keeping: Set<String>) throws -> Int
}

enum CAKeyID {
    static func of(spki: Data) -> String { SHA256.hash(data: spki).map { String(format: "%02x", $0) }.joined() }

    static func isValid(_ text: Substring) -> Bool {
        text.utf8.count == 64 && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

struct SecureEnclaveKeyStore: CAKeyStore {
    let group: String
    let tagPrefix: String

    static let app = SecureEnclaveKeyStore(group: GuardConstants.appGroup + ".ca", tagPrefix: GuardConstants.appBundleId + ".ca:")

    private static let p256SPKIHeader = Data([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
                                              0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00])

    private func query(tag: Data? = nil) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassKey,
                                    kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
                                    kSecAttrAccessGroup as String: group,
                                    kSecUseDataProtectionKeychain as String: true]
        if let tag { query[kSecAttrApplicationTag as String] = tag }
        return query
    }

    private func storedTags() throws -> [Data] {
        var search = query()
        search[kSecMatchLimit as String] = kSecMatchLimitAll
        search[kSecReturnAttributes as String] = true
        var found: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &found)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw CAKeyStoreError.keychain(status) }
        let items = found as? [[String: Any]] ?? []
        return items.compactMap { $0[kSecAttrApplicationTag as String] as? Data }
            .filter { String(decoding: $0, as: UTF8.self).hasPrefix(tagPrefix) }
    }

    private func suffix(_ tag: Data) -> Substring {
        String(decoding: tag, as: UTF8.self).dropFirst(tagPrefix.count)
    }

    private func key(_ id: String) throws -> SecKey? {
        var search = query(tag: Data((tagPrefix + id).utf8))
        search[kSecReturnRef as String] = true
        var found: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &found)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let found, CFGetTypeID(found) == SecKeyGetTypeID() else { throw CAKeyStoreError.keychain(status) }
        return (found as! SecKey)
    }

    private static func spki(_ key: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let pub = SecKeyCopyPublicKey(key), let x963 = SecKeyCopyExternalRepresentation(pub, &error) as Data?, x963.count == 65 else {
            throw CAKeyStoreError.keychain(status(error))
        }
        return p256SPKIHeader + x963
    }

    private static func status(_ error: Unmanaged<CFError>?) -> OSStatus {
        guard let error else { return errSecInternalError }
        return OSStatus(truncatingIfNeeded: CFErrorGetCode(error.takeRetainedValue()))
    }

    func keyIDs() throws -> [String] {
        try storedTags().map { suffix($0) }.filter(CAKeyID.isValid).map(String.init)
    }

    func create() throws -> (id: String, spki: Data) {
        guard SecureEnclave.isAvailable else { throw CAKeyStoreError.noSecureEnclave }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error) else {
            throw CAKeyStoreError.keychain(Self.status(error))
        }
        let pendingTag = Data((tagPrefix + "pending-" + UUID().uuidString).utf8)
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrAccessGroup as String: group,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: pendingTag,
                kSecAttrLabel as String: "Vibtra Guard CA key",
                kSecAttrAccessControl as String: access,
            ] as [String: Any],
        ]
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else { throw CAKeyStoreError.keychain(Self.status(error)) }
        do {
            let spki = try Self.spki(key)
            let id = CAKeyID.of(spki: spki)
            let status = SecItemUpdate(query(tag: pendingTag) as CFDictionary,
                                       [kSecAttrApplicationTag as String: Data((tagPrefix + id).utf8)] as CFDictionary)
            guard status == errSecSuccess else { throw CAKeyStoreError.keychain(status) }
            return (id, spki)
        } catch {
            SecItemDelete(query(tag: pendingTag) as CFDictionary)
            throw error
        }
    }

    func publicKey(_ id: String) throws -> Data? {
        try key(id).map(Self.spki)
    }

    func sign(_ id: String, message: Data) throws -> Data? {
        guard let key = try key(id) else { return nil }
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) as Data? else {
            throw CAKeyStoreError.keychain(Self.status(error))
        }
        return signature
    }

    func delete(keeping: Set<String>) throws -> Int {
        var deleted = 0
        for tag in try storedTags() where !keeping.contains(String(suffix(tag))) {
            let status = SecItemDelete(query(tag: tag) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw CAKeyStoreError.keychain(status) }
            if status == errSecSuccess { deleted += 1 }
        }
        return deleted
    }
}

struct TBSCertificate: Equatable {
    let spki: Data
    let isCA: Bool

    private struct Element {
        let tag: UInt8
        let content: ArraySlice<UInt8>
        let whole: ArraySlice<UInt8>
    }

    private struct Reader {
        var rest: ArraySlice<UInt8>

        var atEnd: Bool { rest.isEmpty }

        func peek() -> UInt8? { rest.first }

        mutating func read(_ tag: UInt8) -> Element? {
            guard rest.count >= 2, rest[rest.startIndex] == tag else { return nil }
            var index = rest.startIndex + 1
            let first = rest[index]
            index += 1
            var length = 0
            if first < 0x80 {
                length = Int(first)
            } else {
                let count = Int(first & 0x7f)
                guard (1...3).contains(count), rest.endIndex - index >= count, rest[index] != 0 else { return nil }
                for byte in rest[index..<index + count] { length = length << 8 | Int(byte) }
                guard length >= 0x80 else { return nil }
                index += count
            }
            guard rest.endIndex - index >= length else { return nil }
            let element = Element(tag: tag, content: rest[index..<index + length], whole: rest[rest.startIndex..<index + length])
            rest = rest[(index + length)...]
            return element
        }
    }

    private static let basicConstraintsOID: [UInt8] = [0x55, 0x1d, 0x13]

    static func parse(_ der: Data) -> TBSCertificate? {
        var outer = Reader(rest: ArraySlice(der))
        guard let tbs = outer.read(0x30), outer.atEnd else { return nil }
        var fields = Reader(rest: tbs.content)
        guard let version = fields.read(0xa0) else { return nil }
        var versionReader = Reader(rest: version.content)
        guard let number = versionReader.read(0x02), versionReader.atEnd, Array(number.content) == [0x02] else { return nil }
        guard fields.read(0x02) != nil, fields.read(0x30) != nil, fields.read(0x30) != nil, fields.read(0x30) != nil, fields.read(0x30) != nil,
              let spki = fields.read(0x30) else { return nil }
        for implicit: UInt8 in [0x81, 0x82] {
            if let tag = fields.peek(), tag == implicit || tag == implicit | 0x20 {
                guard fields.read(tag) != nil else { return nil }
            }
        }
        var isCA = false
        if let wrapper = fields.read(0xa3) {
            var wrapped = Reader(rest: wrapper.content)
            guard let list = wrapped.read(0x30), wrapped.atEnd, !list.content.isEmpty else { return nil }
            var extensions = Reader(rest: list.content)
            var seen = Set<[UInt8]>()
            while !extensions.atEnd {
                guard let ext = extensions.read(0x30) else { return nil }
                var parts = Reader(rest: ext.content)
                guard let oid = parts.read(0x06), seen.insert(Array(oid.content)).inserted else { return nil }
                if parts.peek() == 0x01 {
                    guard let critical = parts.read(0x01), Array(critical.content) == [0xff] else { return nil }
                }
                guard let value = parts.read(0x04), parts.atEnd else { return nil }
                if Array(oid.content) == basicConstraintsOID {
                    guard let ca = basicConstraintsCA(value.content) else { return nil }
                    isCA = ca
                }
            }
        }
        guard fields.atEnd else { return nil }
        return TBSCertificate(spki: Data(spki.whole), isCA: isCA)
    }

    private static func basicConstraintsCA(_ value: ArraySlice<UInt8>) -> Bool? {
        var outer = Reader(rest: value)
        guard let sequence = outer.read(0x30), outer.atEnd else { return nil }
        var fields = Reader(rest: sequence.content)
        var ca = false
        if fields.peek() == 0x01 {
            guard let flag = fields.read(0x01), Array(flag.content) == [0xff] else { return nil }
            ca = true
        }
        if fields.peek() == 0x02 {
            guard fields.read(0x02) != nil else { return nil }
        }
        return fields.atEnd ? ca : nil
    }
}

final class CASession {
    private let store: CAKeyStore
    private var createdKey: String?

    init(store: CAKeyStore) { self.store = store }

    func reply(to line: String) -> String {
        let justCreated = createdKey
        createdKey = nil
        let parts = line.split(separator: " ", omittingEmptySubsequences: false)
        do {
            switch (parts[0], parts.count) {
            case ("keys", 1):
                let ids = try store.keyIDs()
                return ids.isEmpty ? "ok" : "ok " + ids.joined(separator: ",")
            case ("create", 1):
                let created = try store.create()
                createdKey = created.id
                return "ok \(created.id) \(created.spki.base64EncodedString())"
            case ("ca", 3):
                guard CAKeyID.isValid(parts[1]), let tbs = Data(base64Encoded: String(parts[2])) else { return "err bad-request" }
                guard justCreated == String(parts[1]) else { return "err policy ca-only-after-create" }
                return try signCA(String(parts[1]), tbs)
            case ("pub", 2):
                guard CAKeyID.isValid(parts[1]) else { return "err bad-request" }
                guard let spki = try store.publicKey(String(parts[1])) else { return "err no-key" }
                return "ok " + spki.base64EncodedString()
            case ("sign", 4) where parts[2] == "m":
                guard CAKeyID.isValid(parts[1]), let tbs = Data(base64Encoded: String(parts[3])) else { return "err bad-request" }
                return try signLeaf(String(parts[1]), tbs)
            case ("prune", 1), ("prune", 2):
                let keep = parts.count == 2 && !parts[1].isEmpty ? parts[1].split(separator: ",", omittingEmptySubsequences: false) : []
                guard keep.allSatisfy(CAKeyID.isValid) else { return "err bad-request" }
                let deleted = try store.delete(keeping: Set(keep.map(String.init)))
                return "ok \(deleted)"
            default:
                return "err bad-request"
            }
        } catch CAKeyStoreError.noSecureEnclave {
            return "err no-se"
        } catch CAKeyStoreError.keychain(let status) {
            return "err keychain \(status)"
        } catch {
            return "err keychain \(errSecInternalError)"
        }
    }

    private func signCA(_ id: String, _ tbs: Data) throws -> String {
        guard let parsed = TBSCertificate.parse(tbs) else { return "err policy not-tbs" }
        guard parsed.isCA else { return "err policy not-ca" }
        guard let spki = try store.publicKey(id) else { return "err no-key" }
        guard parsed.spki == spki else { return "err policy spki-mismatch" }
        guard let signature = try store.sign(id, message: tbs) else { return "err no-key" }
        return "ok " + signature.base64EncodedString()
    }

    private func signLeaf(_ id: String, _ tbs: Data) throws -> String {
        guard let parsed = TBSCertificate.parse(tbs) else { return "err policy not-tbs" }
        guard !parsed.isCA else { return "err policy is-ca" }
        guard let signature = try store.sign(id, message: tbs) else { return "err no-key" }
        return "ok " + signature.base64EncodedString()
    }
}

final class CASigner: @unchecked Sendable {
    static let socketName = "ca-signer.sock"
    static let maximumLineBytes = 65536

    private let requirement: String?
    private let store: CAKeyStore
    private let directory: URL
    private let requests = NSLock()
    private let refusals = NSLock()
    private var loggedRefusals = Set<String>()
    private var started = false
    private let log = Logger(subsystem: GuardConstants.appBundleId, category: "ca-signer")

    init(requirement: String? = agentRequirement(), store: CAKeyStore = SecureEnclaveKeyStore.app, directory: URL = AgentPaths.dataDir) {
        self.requirement = requirement
        self.store = store
        self.directory = directory
    }

    var socketPath: String { directory.appendingPathComponent(Self.socketName).path }

    func prune(keeping: Set<String>) throws -> Int {
        requests.lock(); defer { requests.unlock() }
        return try store.delete(keeping: keeping)
    }

    func start() {
        guard !started else { return }
        started = true
        let listener: Int32
        do {
            listener = try listen()
        } catch {
            log.error("ca signer not listening on \(self.socketPath, privacy: .public): \(String(describing: error), privacy: .public)")
            return
        }
        let thread = Thread { [self] in acceptLoop(listener) }
        thread.name = "ca-signer"
        thread.start()
    }

    private struct SocketError: Error {
        let step: String
        let errno: Int32
    }

    private func listen() throws -> Int32 {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard chmod(directory.path, 0o700) == 0 else { throw SocketError(step: "chmod dir", errno: errno) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else { throw SocketError(step: "path too long", errno: ENAMETOOLONG) }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: pathBytes)
            raw[pathBytes.count] = 0
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError(step: "socket", errno: errno) }
        guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { let e = errno; close(fd); throw SocketError(step: "cloexec", errno: e) }
        unlink(socketPath)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0 else { let e = errno; close(fd); throw SocketError(step: "bind", errno: e) }
        guard chmod(socketPath, 0o600) == 0, Darwin.listen(fd, 8) == 0 else { let e = errno; close(fd); throw SocketError(step: "listen", errno: e) }
        return fd
    }

    private func acceptLoop(_ listener: Int32) {
        while true {
            let fd = accept(listener, nil, nil)
            if fd < 0 {
                if errno == EBADF || errno == EINVAL { return }
                if errno != EINTR && errno != ECONNABORTED { usleep(100_000) }
                continue
            }
            guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { close(fd); continue }
            var on: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            let thread = Thread { [self] in serve(fd) }
            thread.name = "ca-signer connection"
            thread.start()
        }
    }

    private func serve(_ fd: Int32) {
        defer { close(fd) }
        let connection = LineConnection(fd)
        let token: Data
        switch isOurAgent(fd: fd, requirement: requirement) {
        case .ours(let caller):
            token = caller
        case .unsigned:
            refuse(connection, "unsigned")
            return
        case .otherCode:
            refuse(connection, "requirement")
            return
        }
        guard bindCaller(connection, fd: fd, token: token) else {
            refuse(connection, "binding")
            return
        }
        guard connection.write("ready") else { return }
        let session = CASession(store: store)
        while let received = connection.read() {
            guard let line = received else {
                _ = connection.write("err bad-request")
                return
            }
            guard stillBound(connection, fd: fd, token: token) else {
                logRefusal("binding")
                return
            }
            requests.lock()
            let reply = session.reply(to: line)
            requests.unlock()
            guard connection.write(reply) else { return }
        }
    }

    private func refuse(_ connection: LineConnection, _ reason: String) {
        _ = connection.write("err unauthorised " + reason)
        logRefusal(reason)
    }

    private func logRefusal(_ reason: String) {
        refusals.lock()
        let first = loggedRefusals.insert(reason).inserted
        refusals.unlock()
        if first { log.notice("ca signer refused a caller: \(reason, privacy: .public)") }
    }
}

private final class LineConnection {
    private let fd: Int32
    private var buffer: [UInt8] = []

    init(_ fd: Int32) { self.fd = fd }

    var hasUnreadBytes: Bool {
        var pending: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        return !buffer.isEmpty || getsockopt(fd, SOL_SOCKET, SO_NREAD, &pending, &length) != 0 || pending > 0
    }

    func read() -> String?? {
        while true {
            if let end = buffer.firstIndex(of: 10) {
                guard end <= CASigner.maximumLineBytes else { return .some(nil) }
                let line = buffer[..<end]
                buffer.removeSubrange(...end)
                return line.allSatisfy({ (32...126).contains($0) }) ? .some(String(decoding: line, as: UTF8.self)) : .some(nil)
            }
            if buffer.count > CASigner.maximumLineBytes { return .some(nil) }
            var chunk = [UInt8](repeating: 0, count: min(16384, CASigner.maximumLineBytes + 1 - buffer.count))
            let n = Darwin.read(fd, &chunk, chunk.count)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { return nil }
            buffer.append(contentsOf: chunk[..<n])
        }
    }

    func write(_ line: String) -> Bool {
        let bytes = Array((line + "\n").utf8)
        var offset = 0
        while offset < bytes.count {
            let n = bytes[offset...].withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { return false }
            offset += n
        }
        return true
    }
}
