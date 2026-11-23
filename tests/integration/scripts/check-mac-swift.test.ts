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

const check = async (swift: string, file = FILE) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "check-mac-swift-"));
  roots.push(root);
  await mkdir(path.join(root, path.dirname(file)), { recursive: true });
  await writeFile(path.join(root, file), swift);
  const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
  return [result.status, result.stderr.trim()];
};

const debugRefusal = (line: number, statement: string) => `check-mac-swift: ${FILE}:${line}: #if DEBUG holds \`${statement}\`, not only constants. ${DEBUG_FIX}`;
const privacyRefusal = (line: number, value: string, file = FILE) =>
  `check-mac-swift: ${file}:${line}: \`${value}\` is logged with privacy: .public. Hosts, signing ids and user paths are privacy: .private in the Mac app. Use privacy: .private, or, if the value is none of those, add it under ${file} in PUBLIC in scripts/check-mac-swift.mjs with what it is.`;
const rawLogRefusal = (line: number, call: string) =>
  `check-mac-swift: ${FILE}:${line}: ${call}( bypasses this check, and NSLog logs every argument public. Use Logger, with privacy: .private on hosts, signing ids and user paths.`;

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
    const file = "guard/mac/VibtraGuardExtension/FilterDataProvider.swift";
    const swift = `enum MadeUp {
    static func log() {
        log.notice("dropped QUIC to \\(address ?? "?", privacy: .public) (\\(serviceId, privacy: .public))")
        log.info("learnt \\(count) addresses of \\(answer.name, privacy: .public)")
        log.error("\\(String(describing: target.endpoint), privacy: .public): \\(error.localizedDescription, privacy: .public)")
    }
}
`;
    expect(await check(swift, file)).toEqual([
      1,
      [privacyRefusal(3, 'address ?? "?"', file), privacyRefusal(4, "answer.name", file), privacyRefusal(5, "String(describing: target.endpoint)", file)].join("\n"),
    ]);
  });

  it("passes private and default privacy, and the agent's loopback host in FlowRelay.swift", async () => {
    const swift = `enum MadeUp {
    static func log() {
        log.notice("\\(signingId, privacy: .private) to \\(host) on \\(self.config.agentHost, privacy: .public):\\(port)")
    }
}
`;
    expect(await check(swift, "guard/mac/Shared/FlowRelay.swift")).toEqual([0, ""]);
  });

  it("fails on a name PUBLIC lists for another file, as reason, why and String(describing: error) are", async () => {
    const swift = `enum MadeUp {
    static func log() {
        let reason = flow.remoteHostname ?? "?"
        log.info("x \\(reason, privacy: .public)")
        let why = "no route to \\(host) for \\(signingId)"
        log.error("\\(why, privacy: .public)")
        log.error("sync failed: \\(String(describing: error), privacy: .public)")
    }
}
`;
    expect(await check(swift)).toEqual([1, [privacyRefusal(4, "reason"), privacyRefusal(6, "why"), privacyRefusal(7, "String(describing: error)")].join("\n")]);
  });

  it("fails on the CA socket path under /Users and its error logged public, as CASigner.swift:554 did on main", async () => {
    const file = "guard/mac/VibtraGuard/CASigner.swift";
    const swift = `final class CASigner {
    func start() {
        do {
            listener = try listen()
        } catch {
            log.error("ca signer not listening on \\(self.socketPath, privacy: .public): \\(String(describing: error), privacy: .public)")
            return
        }
    }
}
`;
    expect(await check(swift, file)).toEqual([1, [privacyRefusal(6, "self.socketPath", file), privacyRefusal(6, "String(describing: error)", file)].join("\n")]);
  });

  it("fails on a direct-connection error logged public, as FlowRelay.swift:327 and :359 did on main", async () => {
    const file = "guard/mac/Shared/FlowRelay.swift";
    const swift = `final class FlowRelay {
    func perform(_ why: String?) {
        log.notice("\\(self.destinationHost, privacy: .private):\\(self.destinationPort): \\(why ?? "agent unreachable", privacy: .public); relaying direct (fail open, replaying \\(replaying) bytes)")
        log.error("\\(self.destinationHost, privacy: .private): \\(why ?? "closed", privacy: .public); closing the flow")
    }
}
`;
    expect(await check(swift, file)).toEqual([1, [privacyRefusal(3, 'why ?? "agent unreachable"', file), privacyRefusal(4, 'why ?? "closed"', file)].join("\n")]);
  });

  it("fails on OSLogPrivacy.public, a space before the colon and a raw-string interpolation", async () => {
    const swift = `enum MadeUp {
    static func log() {
        log.info("x \\(signingId, privacy: OSLogPrivacy.public)")
        log.info("x \\(signingId, privacy : .public)")
        log.info(#"x \\#(signingId, privacy: .public)"#)
    }
}
`;
    expect(await check(swift)).toEqual([1, [privacyRefusal(3, "signingId"), privacyRefusal(4, "signingId"), privacyRefusal(5, "signingId")].join("\n")]);
  });

  it("fails on NSLog and os_log, as ExtensionController.swift:525 used on main", async () => {
    const swift = `final class MadeUp {
    func failed(_ failure: ActivationFailure) {
        NSLog("Vibtra Guard: system extension request failed: %@", failure.text)
        os_log("%{public}@", signingId)
    }
}
`;
    expect(await check(swift)).toEqual([1, [rawLogRefusal(3, "NSLog"), rawLogRefusal(4, "os_log")].join("\n")]);
  });
});
