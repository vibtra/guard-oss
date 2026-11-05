// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation
#if canImport(Darwin)
import Darwin
#endif

public enum ProxyProtocolV1 {
    public static let maxLength = 107

    public enum Family: String { case tcp4 = "TCP4", tcp6 = "TCP6" }

    public static func family(of address: String) -> Family? {
        var v4 = in_addr()
        if inet_pton(AF_INET, address, &v4) == 1 { return .tcp4 }
        var v6 = in6_addr()
        if inet_pton(AF_INET6, strippingBrackets(address), &v6) == 1 { return .tcp6 }
        return nil
    }

    private static func strippingBrackets(_ s: String) -> String {
        if s.hasPrefix("[") && s.hasSuffix("]") { return String(s.dropFirst().dropLast()) }
        return s
    }

    public static func line(sourceHost: String?, sourcePort: Int?, destinationHost: String, destinationPort: Int) -> String {
        let dst = strippingBrackets(destinationHost)
        guard let fam = family(of: dst), (0...65535).contains(destinationPort) else { return "PROXY UNKNOWN\r\n" }
        let loopback = fam == .tcp4 ? "127.0.0.1" : "::1"
        var src = sourceHost.map(strippingBrackets) ?? loopback
        if family(of: src) != fam { src = loopback }
        var sport = sourcePort ?? 0
        if !(0...65535).contains(sport) { sport = 0 }
        let out = "PROXY \(fam.rawValue) \(src) \(dst) \(sport) \(destinationPort)\r\n"
        return out.utf8.count <= maxLength ? out : "PROXY UNKNOWN\r\n"
    }

    public static func data(sourceHost: String?, sourcePort: Int?, destinationHost: String, destinationPort: Int) -> Data {
        Data(line(sourceHost: sourceHost, sourcePort: sourcePort, destinationHost: destinationHost, destinationPort: destinationPort).utf8)
    }
}
