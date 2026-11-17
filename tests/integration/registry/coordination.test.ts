import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInProcessCoordinator } from "@vibtra/registry/src/store/coordination.ts";
import { createPostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { postgresMissing } from "./server-options.ts";

describe("the in-process coordinator's windows", () => {
  it("keeps each bucket's own window when another bucket with a shorter window sweeps", async () => {
    let at = 0;
    const coordinator = createInProcessCoordinator(() => at);
    expect((await coordinator.take("hourly", 2, 3_600_000)).count).toBe(1);
    at = 61_000;
    expect((await coordinator.take("brief", 2, 10_000)).count).toBe(1);
    expect(await coordinator.take("hourly", 2, 3_600_000)).toMatchObject({ ok: true, count: 2 });
    expect(await coordinator.take("hourly", 2, 3_600_000)).toMatchObject({ ok: false, count: 3, firstRefusal: true, retryAfterSeconds: 3_539 });
  });

  it("opens a fresh window once a bucket's own window has passed", async () => {
    let at = 0;
    const coordinator = createInProcessCoordinator(() => at);
    await coordinator.take("brief", 1, 10_000);
    expect((await coordinator.take("brief", 1, 10_000)).ok).toBe(false);
    at = 10_000;
    expect(await coordinator.take("brief", 1, 10_000)).toMatchObject({ ok: true, count: 1 });
  });
});

describe.skipIf(postgresMissing())("the Postgres coordinator's windows", () => {
  it("dates each window from the clock it was given, so a window passes when that clock does", async () => {
    let at = Date.parse("2026-11-17T09:00:00.000Z");
    const stores = createPostgresRegistryStores(process.env.VIBTRA_TEST_DATABASE_URL ?? "", () => at);
    try {
      await stores.migrate();
      const bucket = `test-window-${randomBytes(4).toString("hex")}`;
      expect((await stores.coordinator.take(bucket, 1, 3_600_000)).ok).toBe(true);
      at += 60_000;
      expect(await stores.coordinator.take(bucket, 1, 3_600_000)).toMatchObject({ ok: false, count: 2, firstRefusal: true, retryAfterSeconds: 3_540 });
      at += 3_540_000;
      expect(await stores.coordinator.take(bucket, 1, 3_600_000)).toMatchObject({ ok: true, count: 1 });
    } finally {
      await stores.close();
    }
  });
});
