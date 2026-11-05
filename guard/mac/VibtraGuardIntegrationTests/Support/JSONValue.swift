// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation

indirect enum JSONValue: Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(foundation any: Any) throws {
        switch any {
        case is NSNull:
            self = .null
        case let text as String:
            self = .string(text)
        case let number as NSNumber:
            if CFGetTypeID(number as CFTypeRef) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else if number.doubleValue == Double(number.intValue) {
                self = .int(number.intValue)
            } else {
                throw IntegrationError("a policy document may only hold integers, not \(number)")
            }
        case let items as [Any]:
            self = .array(try items.map { try JSONValue(foundation: $0) })
        case let fields as [String: Any]:
            self = .object(try fields.mapValues { try JSONValue(foundation: $0) })
        default:
            throw IntegrationError("not a JSON value: \(type(of: any))")
        }
    }

    static func parse(_ data: Data) throws -> JSONValue {
        try JSONValue(foundation: JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
    }

    subscript(key: String) -> JSONValue? {
        if case let .object(fields) = self { return fields[key] }
        return nil
    }

    var stringValue: String? {
        if case let .string(text) = self { return text }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case let .array(items) = self { return items }
        return nil
    }

    func setting(_ key: String, _ value: JSONValue) -> JSONValue {
        guard case var .object(fields) = self else { return self }
        fields[key] = value
        return .object(fields)
    }

    var canonical: Data {
        var out = ""
        write(into: &out)
        return Data(out.utf8)
    }

    private func write(into out: inout String) {
        switch self {
        case .null:
            out += "null"
        case let .bool(flag):
            out += flag ? "true" : "false"
        case let .int(number):
            out += String(number)
        case let .string(text):
            Self.quote(text, into: &out)
        case let .array(items):
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                item.write(into: &out)
            }
            out += "]"
        case let .object(fields):
            out += "{"
            let keys = fields.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            for (index, key) in keys.enumerated() {
                if index > 0 { out += "," }
                Self.quote(key, into: &out)
                out += ":"
                fields[key]?.write(into: &out)
            }
            out += "}"
        }
    }

    private static func quote(_ text: String, into out: inout String) {
        out += "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}
