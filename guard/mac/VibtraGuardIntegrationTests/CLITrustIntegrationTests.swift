// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation
import XCTest

final class CLITrustIntegrationTests: GuardIntegrationCase {
    private let zsh = URL(fileURLWithPath: "/bin/zsh")
    private let security = URL(fileURLWithPath: "/usr/bin/security")

    private func certificates(in keychain: String) throws -> String {
        try Command.run(security, ["find-certificate", "-a", "-p", keychain], captureErrors: false).output
    }

    func testTheSnippetMakesCommandLineToolsTrustTheAgentWithoutDroppingTheirRoots() throws {
        let fixture = try makeFixture()
        let export = try fixture.agent.command(["ca", "export"])
        XCTAssertEqual(export.status, 0, export.output)
        let guardCA = export.output
        XCTAssertTrue(CLITrust.isPEMCertificate(guardCA), "ca export prints the agent's certificate")
        XCTAssertFalse(CLITrust.isPEMCertificate("error: not enrolled"))

        let roots = try certificates(in: CLITrust.systemRootsKeychain)
        let admin = try certificates(in: CLITrust.adminKeychain)
        let base = try IntegrationPaths.temporaryDirectory("cli-trust")
        addTeardownBlock { try? FileManager.default.removeItem(at: base) }
        let dir = base.appendingPathComponent("Vibtra Guard it's", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let caFile = dir.appendingPathComponent(CLITrust.caFileName)
        let bundleFile = dir.appendingPathComponent(CLITrust.bundleFileName)
        try Data(guardCA.utf8).write(to: caFile, options: .atomic)
        let bundle = CLITrust.bundle(systemRoots: roots, adminCAs: admin, guardCA: guardCA)
        try Data(bundle.utf8).write(to: bundleFile, options: .atomic)

        let rootBlocks = PEM.blocks(roots)
        let adminBlocks = PEM.blocks(admin)
        let bundleBlocks = PEM.blocks(bundle)
        XCTAssertGreaterThan(rootBlocks.count, 20, "the system roots keychain was read")
        XCTAssertEqual(bundleBlocks.count, rootBlocks.count + adminBlocks.count + 1)
        XCTAssertEqual(Array(bundleBlocks.prefix(rootBlocks.count)), rootBlocks, "every system root stays in the store SSL_CERT_FILE replaces")
        XCTAssertEqual(Array(bundleBlocks.dropFirst(rootBlocks.count).prefix(adminBlocks.count)), adminBlocks, "the admin-trusted CAs follow the roots")
        XCTAssertTrue(bundle.hasSuffix("\n"))
        XCTAssertEqual(bundleBlocks.last, PEM.blocks(guardCA).first, "the Guard CA comes last")

        let snippet = CLITrust.snippet(directory: dir.path + "/")
        XCTAssertEqual(CLITrust.shellQuoted("/tmp/it's"), "'/tmp/it'\\''s'")
        let exported = try Command.run(zsh, ["-f", "-c", snippet + "\nfor v in NODE_EXTRA_CA_CERTS SSL_CERT_FILE REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_SSL_CAINFO; do print -r -- \"${(P)v}\"; done\n"])
        XCTAssertEqual(exported.status, 0, exported.output)
        XCTAssertEqual(exported.output.split(separator: "\n").map(String.init),
                       [caFile.path, bundleFile.path, bundleFile.path, bundleFile.path, bundleFile.path],
                       "a path with a space and an apostrophe survives the shell")

        let proxy = "http://127.0.0.1:\(fixture.agent.proxyPort)"
        func curl(_ trust: String) throws -> CommandResult {
            try Command.run(zsh, ["-f", "-c", snippet + "\n/usr/bin/curl -sS --max-time 15 --proxy \(proxy) --cacert \(trust) https://chatgpt.com/cli-trust-check\n"])
        }
        let viaBundle = try curl("\"$CURL_CA_BUNDLE\"")
        XCTAssertEqual(viaBundle.status, 0, viaBundle.output)
        XCTAssertEqual(viaBundle.output, GuardFixture.upstreamBody, "curl trusts the agent's certificate through the bundle")
        let viaCA = try curl("\"$NODE_EXTRA_CA_CERTS\"")
        XCTAssertEqual(viaCA.status, 0, viaCA.output)
        let rootsOnly = base.appendingPathComponent("roots-only.pem")
        try Data(roots.utf8).write(to: rootsOnly)
        let refused = try curl(CLITrust.shellQuoted(rootsOnly.path))
        XCTAssertNotEqual(refused.status, 0, "without the Guard CA the intercepted host is refused: \(refused.output)")
        XCTAssertEqual(fixture.upstream.requests.filter { $0.path == "/cli-trust-check" }.count, 2, "both trusted runs reached the upstream and the refused one did not")
    }
}
