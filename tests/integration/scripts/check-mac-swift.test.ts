import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-mac-swift.mjs", import.meta.url));
const FILE = "guard/mac/VibtraGuard/MadeUp.swift";
const DEBUG_FIX =
  "Debug-only CI never compiles the other branch, so code there is first compiled at release (guard-oss#81). Put only a constant behind #if DEBUG, such as `private static let checksLocation = false` under #if DEBUG and `= true` under #else, and branch on it in plain code (ExtensionController.checksLocation).";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const check = async (swift: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "check-mac-swift-"));
  roots.push(root);
  await mkdir(path.join(root, path.dirname(FILE)), { recursive: true });
  await writeFile(path.join(root, FILE), swift);
  const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
  return [result.status, result.stderr.trim()];
};

const debugRefusal = (line: number, statement: string) => `check-mac-swift: ${FILE}:${line}: #if DEBUG holds \`${statement}\`, not only constants. ${DEBUG_FIX}`;
const privacyRefusal = (line: number, value: string) =>
  `check-mac-swift: ${FILE}:${line}: \`${value}\` is logged with privacy: .public. Hosts and signing ids are privacy: .private in the Mac app. Use privacy: .private, or, if the value is neither a host nor a signing id, add it to PUBLIC in scripts/check-mac-swift.mjs with what it is.`;

describe("check-mac-swift", () => {
  it("passes the committed Mac app", () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  it("fails on the release-only location check from guard-oss#81 before its fix (93d33e8)", async () => {
    const swift = `final class ExtensionController {
    private func refuseOutsideApplications(_ trigger: ExtensionRequestTrigger) -> Bool {
        #if DEBUG
        return false
        #else
        guard !AppLocation.isInSystemApplications(Bundle.main.bundleURL.resolvingSymlinksInPath()) else { return false }
        refuseForLocation(trigger)
        return true
        #endif
    }
}
`;
    expect(await check(swift)).toEqual([1, debugRefusal(3, "return false")]);
  });

  it("names statements in the #else branch too", async () => {
    const swift = `enum MadeUp {
    static func pick() -> Bool {
        #if DEBUG
        #else
        guard check() else { return false }
        #endif
        return true
    }
}
`;
    expect(await check(swift)).toEqual([1, debugRefusal(3, "guard check() else { return false }")]);
  });

  it("fails on #if !DEBUG, #elseif DEBUG and an #if nested inside #if DEBUG", async () => {
    const swift = `enum MadeUp {
    #if !DEBUG
    static func a() {}
    #endif
    #if os(macOS)
    static let b = 1
    #elseif DEBUG
    static let b = 2
    #else
    static func b() {}
    #endif
    #if DEBUG
    #if os(macOS)
    static let c = 1
    #endif
    #endif
}
`;
    expect(await check(swift)).toEqual([1, [debugRefusal(2, "static func a() {}"), debugRefusal(5, "static func b() {}"), debugRefusal(12, "#if os(macOS)")].join("\n")]);
  });

  it("passes #if DEBUG that only selects a constant, as ExtensionController.checksLocation does", async () => {
    const swift = `final class ExtensionController {
    #if DEBUG
    private static let checksLocation = false
    #else
    private static let checksLocation = true
    #endif

    #if DEBUG
    static let name: String = "debug"
    #elseif BETA
    static let name: String = "beta"
    #else
    static let name: String = "release"
    #endif

    #if os(macOS)
    func anything() { print("not a Debug branch") }
    #endif
}
`;
    expect(await check(swift)).toEqual([0, ""]);
  });

  it("fails on a signing id logged public, as SigningIdentity.swift:62 did on main", async () => {
    const swift = `enum SigningIdentity {
    static func verify(signingId: String) {
        if valid { log.notice("verified Codex work process \\(signingId, privacy: .public); disabled catalogue row bypasses TCP/QUIC inspection") }
    }
}
`;
    expect(await check(swift)).toEqual([1, privacyRefusal(3, "signingId")]);
  });

  it("fails on any value logged public that PUBLIC does not list, a host under another name included", async () => {
    const swift = `enum MadeUp {
    static func log() {
        log.notice("dropped QUIC to \\(address ?? "?", privacy: .public) (\\(serviceId, privacy: .public))")
        log.info("learnt \\(count) addresses of \\(answer.name, privacy: .public)")
        log.error("\\(String(describing: target.endpoint), privacy: .public): \\(error.localizedDescription, privacy: .public)")
    }
}
`;
    expect(await check(swift)).toEqual([1, [privacyRefusal(3, 'address ?? "?"'), privacyRefusal(4, "answer.name"), privacyRefusal(5, "String(describing: target.endpoint)")].join("\n")]);
  });

  it("passes private and default privacy, and the agent's loopback host", async () => {
    const swift = `enum MadeUp {
    static func log() {
        log.notice("\\(signingId, privacy: .private) to \\(host) on \\(self.config.agentHost, privacy: .public):\\(port)")
    }
}
`;
    expect(await check(swift)).toEqual([0, ""]);
  });
});
