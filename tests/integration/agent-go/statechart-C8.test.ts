import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundleDocument, catalogueDocument, createSigner, deviceDocument, runAgentCommand, signEnvelope, startFakeRegistry, tempDir, type FakeRegistry } from "./harness.ts";
import { record, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();

interface Server {
  readonly registry: FakeRegistry;
  readonly deviceId: string;
  readonly issued: string[];
}

const server = async (): Promise<Server> => {
  const signer = createSigner();
  const registry = await startFakeRegistry(suite.cleanup, signer);
  registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer)), catalogue: signEnvelope(signer, "catalogue", catalogueDocument()) });
  const issued: string[] = [];
  registry.override((call) => {
    if (call.door !== "enrol") return undefined;
    const deviceToken = `gdt_${signer.deviceId}_${issued.length}`;
    issued.push(deviceToken);
    return { status: 200, body: { ...deviceDocument(signer, registry.url), deviceToken } };
  });
  return { registry, deviceId: signer.deviceId, issued };
};

const enrol = (dataDir: string, to: Server, crashAt?: string) =>
  runAgentCommand(suite.binary(), ["enrol", "--server", to.registry.url, "--token", `genr_${"0".repeat(32)}`], { dataDir, env: crashAt === undefined ? {} : { VIBTRA_GUARD_TEST_CRASH_AT: crashAt } });

const bearers = (to: Server): string[] =>
  to.registry.calls.flatMap((call) => (typeof call.headers.authorization === "string" ? [call.headers.authorization.replace(/^Bearer /, "")] : []));

describe("statechart C8: a crash during enrolment never leaves a Mac half enrolled", () => {
  for (const crashAt of ["enrol-before-token", "enrol-after-token"]) {
    it(`re-enrolling with a crash at ${crashAt} leaves no bearer paired with another enrolment's device`, async () => {
      const a = await server();
      const b = await server();
      const dataDir = await tempDir(suite.cleanup, "enrol-crash");
      const first = await enrol(dataDir, a);
      expect(first.code, first.stderr).toBe(0);

      const crashed = await enrol(dataDir, b, crashAt);
      expect(crashed.code, "the enrol was killed at the crash point").toBe(86);

      const device = await readFile(path.join(dataDir, "device.json"), "utf8").then((raw) => record(JSON.parse(raw)), () => undefined);
      const token = (await readFile(path.join(dataDir, "device.token"), "utf8")).trim();
      if (device !== undefined) {
        const owner = device.deviceId === a.deviceId ? a : b;
        expect(owner.issued, `device.json names ${String(device.deviceId)}, so device.token must be a bearer its registry issued`).toContain(token);
      }

      const sync = await runAgentCommand(suite.binary(), ["sync"], { dataDir });
      expect([...bearers(a).filter((bearer) => !a.issued.includes(bearer)), ...bearers(b).filter((bearer) => !b.issued.includes(bearer))], "no registry gets another enrolment's bearer").toEqual([]);
      if (device === undefined) expect(sync.stderr).toContain("not enrolled");

      const again = await enrol(dataDir, b);
      expect(again.code, again.stderr).toBe(0);
      expect(record(JSON.parse(await readFile(path.join(dataDir, "device.json"), "utf8"))).deviceId).toBe(b.deviceId);
      expect((await readFile(path.join(dataDir, "device.token"), "utf8")).trim()).toBe(b.issued.at(-1));
    });
  }
});
