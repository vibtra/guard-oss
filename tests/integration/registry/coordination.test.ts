import { describe, expect, it } from "vitest";
import { createInProcessCoordinator } from "@vibtra/registry/src/store/coordination.ts";

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
