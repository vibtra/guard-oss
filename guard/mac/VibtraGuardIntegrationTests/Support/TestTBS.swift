// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation

enum TestTBS {
    private static let basicConstraintsOID: [UInt8] = [0x55, 0x1d, 0x13]

    static func certificate(spki: Data, ca: Bool?) -> Data {
        let name = commonName("Guard test")
        let validity = tlv(0x30, tlv(0x17, Array("260101000000Z".utf8)) + tlv(0x17, Array("260102000000Z".utf8)))
        let extensions = ca.map { [ext(basicConstraintsOID, critical: true, tlv(0x30, $0 ? tlv(0x01, [0xff]) : []))] } ?? []
        return tbs(issuer: name, validity: validity, subject: name, spki: spki, extensions: extensions)
    }

    static func leaf(spki: Data, basicConstraints: Bool = false) -> Data {
        let now = Date()
        let host = "guard-test.example"
        var extensions = [ext([0x55, 0x1d, 0x0f], critical: true, tlv(0x03, [0x07, 0x80])),
                          ext([0x55, 0x1d, 0x25], critical: false, tlv(0x30, tlv(0x06, [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01])))]
        if basicConstraints { extensions.append(ext(basicConstraintsOID, critical: true, tlv(0x30, []))) }
        extensions.append(ext([0x55, 0x1d, 0x23], critical: false, tlv(0x30, tlv(0x80, [UInt8](repeating: 0x11, count: 20)))))
        extensions.append(ext([0x55, 0x1d, 0x11], critical: false, tlv(0x30, tlv(0x82, Array(host.utf8)))))
        let validity = tlv(0x30, utcTime(now.addingTimeInterval(-3600)) + utcTime(now.addingTimeInterval(24 * 3600)))
        return tbs(issuer: commonName("Vibtra Guard local CA"), validity: validity, subject: commonName(host), spki: spki, extensions: extensions)
    }

    private static func tbs(issuer: [UInt8], validity: [UInt8], subject: [UInt8], spki: Data, extensions: [[UInt8]]) -> Data {
        let algorithm = tlv(0x30, [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])
        var fields = tlv(0xa0, tlv(0x02, [0x02])) + tlv(0x02, [0x01]) + algorithm + issuer + validity + subject + Array(spki)
        if !extensions.isEmpty { fields += tlv(0xa3, tlv(0x30, extensions.flatMap { $0 })) }
        return Data(tlv(0x30, fields))
    }

    private static func commonName(_ text: String) -> [UInt8] {
        tlv(0x30, tlv(0x31, tlv(0x30, [0x06, 0x03, 0x55, 0x04, 0x03] + tlv(0x0c, Array(text.utf8)))))
    }

    private static func ext(_ oid: [UInt8], critical: Bool, _ value: [UInt8]) -> [UInt8] {
        tlv(0x30, tlv(0x06, oid) + (critical ? tlv(0x01, [0xff]) : []) + tlv(0x04, value))
    }

    private static func utcTime(_ date: Date) -> [UInt8] {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyMMddHHmmss'Z'"
        return tlv(0x17, Array(formatter.string(from: date).utf8))
    }

    private static func tlv(_ tag: UInt8, _ content: [UInt8]) -> [UInt8] {
        let count = content.count
        let length: [UInt8] = count < 0x80 ? [UInt8(count)] : count < 0x100 ? [0x81, UInt8(count)] : [0x82, UInt8(count >> 8), UInt8(count & 0xff)]
        return [tag] + length + content
    }
}
