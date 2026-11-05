import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadHostedBilling } from "@vibtra/registry/src/hosted-billing.ts";
import { startRegistry, type TestRegistry } from "../../support/registry.ts";

let tmp = "";

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "guard-hosted-billing-"));
});

afterAll(async () => {
  if (tmp !== "") await rm(tmp, { recursive: true, force: true });
});

describe("the hosted billing seam in the Community Edition", () => {
  it("loads nothing when the billing module is not in the tree", async () => {
    await expect(loadHostedBilling(pathToFileURL(path.join(tmp, "billing", "hosted.js")).href)).resolves.toBeUndefined();
  });

  it("does not hide a billing module that is present but broken", async () => {
    const broken = path.join(tmp, "broken.mjs");
    await writeFile(broken, 'import "@vibtra/no-such-package-for-billing";\nexport const hostedBilling = {};\n');
    await expect(loadHostedBilling(pathToFileURL(broken).href)).rejects.toThrow(/no-such-package-for-billing/);
  });

  describe("a registry started without billing", () => {
    let registry: TestRegistry;

    beforeAll(async () => {
      registry = await startRegistry({ configure: (options) => ({ ...options, billing: false }) });
    });

    afterAll(async () => {
      await registry?.close();
    });

    it("registers no billing or Stripe routes and still serves Guard", async () => {
      const { app } = registry.server;
      expect(app.hasRoute({ method: "GET", url: "/api/console/billing" })).toBe(false);
      expect(app.hasRoute({ method: "POST", url: "/billing/stripe/webhook" })).toBe(false);
      const session = await registry.consoleGet(registry.people.owner, "/session");
      expect(session.status).toBe(200);
    });
  });
});
