import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRegistry, type TestRegistry } from "../../support/registry.ts";
import { enrolDevice, page } from "./guard-device.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";

let tmp: string;
let registry: TestRegistry;

const get = (url: string, cookie?: string) => page(`${registry.url}${url}`, cookie === undefined ? {} : { headers: { cookie } });

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "guard-mount-"));
  const consoleDist = path.join(tmp, "console");
  const guardDist = path.join(tmp, "guard");
  const landingDist = path.join(tmp, "landing");
  await mkdir(consoleDist, { recursive: true });
  await mkdir(guardDist, { recursive: true });
  await mkdir(path.join(landingDist, "assets"), { recursive: true });
  await writeFile(path.join(consoleDist, "index.html"), "<!doctype html><title>main console</title>");
  await writeFile(path.join(consoleDist, "index-AbCdEf12.js"), "console.log('main')");
  await writeFile(path.join(guardDist, "index.html"), '<!doctype html><title>guard console</title><script src="/assets/guard/index-Gu4rd_01.js"></script>');
  await writeFile(path.join(guardDist, "index-Gu4rd_01.js"), "console.log('guard')");
  await writeFile(
    path.join(landingDist, "index.html"),
    '<!doctype html><html><head><title>Guard by Vibtra</title><script type="module" src="/landing/assets/main-abc123.js"></script></head><body></body></html>',
  );
  await writeFile(path.join(landingDist, "assets", "main-abc123.js"), "export {};\n");
  registry = await startRegistry({
    domain: "guard-mount.example",
    configure: (options) => ({ ...options, consoleDistDir: consoleDist, guardConsoleDistDir: guardDist, landingDistDir: landingDist }),
  });
});

afterAll(async () => {
  await registry?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("the Guard console mount", () => {
  it("serves the Guard SPA at /<handle>/guard and its deep links, and refuses the old console routes", async () => {
    for (const url of ["/acme/guard", "/acme/guard/rules", "/acme/guard/devices/gdev_0123456789abcdef"]) {
      const res = await get(url);
      expect([url, res.status]).toEqual([url, 200]);
      expect(res.text).toContain("guard console");
    }
    expect((await get("/acme/rules")).status).toBe(404);
    expect((await get("/acme")).status).toBe(404);
  });

  it("answers 404 under /guard when the first segment can never be a handle", async () => {
    expect((await get("/Acme/guard")).status).toBe(404);
    expect((await get("/api/guard")).status).toBe(404);
    expect((await get("/assets/guard")).status).toBe(404);
  });

  it("serves /assets/guard/* as immutable, answers a miss with a no-store 404, and serves no main console chunk", async () => {
    const js = await get("/assets/guard/index-Gu4rd_01.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(js.text).toContain("guard");
    const miss = await get("/assets/guard/index-OldChunk.js");
    expect(miss.status).toBe(404);
    expect(miss.headers.get("cache-control")).toBe("no-store");
    expect((await get("/assets/index-AbCdEf12.js")).status).toBe(404);
    expect((await get("/acme/guard/index-Gu4rd_01.js")).status).toBe(404);
  });

  it("answers 503 with the build command when nothing is built, and still 404s what is no handle", async () => {
    const bare = await startRegistry({
      domain: "guard-unbuilt.example",
      configure: (options) => ({ ...options, consoleDistDir: path.join(tmp, "none"), guardConsoleDistDir: path.join(tmp, "none-guard") }),
    });
    try {
      const unbuilt = await page(`${bare.url}/acme/guard/rules`);
      expect(unbuilt.status).toBe(503);
      expect(unbuilt.text).toContain("pnpm --filter @vibtra/guard-console build");
      expect((await page(`${bare.url}/Acme/guard`)).status).toBe(404);
      expect((await page(`${bare.url}/assets/guard/x.js`)).status).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

describe("the Guard landing at the apex", () => {
  it("serves the built landing document at /", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<title>Guard by Vibtra</title>");
  });

  it("serves the landing's files under /landing/", async () => {
    const res = await get("/landing/assets/main-abc123.js");
    expect(res.status).toBe(200);
    expect(res.text).toBe("export {};\n");
  });

  it("sends the bare /landing and /landing/ to the landing at /", async () => {
    for (const url of ["/landing", "/landing/"]) {
      const res = await get(url);
      expect([url, res.status]).toEqual([url, 301]);
      expect(res.headers.get("location"), url).toBe("/");
    }
  });

  it("sends /pricing to the landing's pilot row with a 302: no prices are published (closed pilots)", async () => {
    const res = await get("/pricing");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#faq-pilot");
    expect(res.text).not.toMatch(/\$\d/);
  });
});

describe("the standalone Guard product", () => {
  it("keeps sign-in and CSRF on the Guard doors and answers 404 on every retired product surface", async () => {
    const { owner, member } = registry.people;
    for (const url of [
      "/api/console/workspaces",
      "/api/console/tools",
      "/api/console/connections",
      "/v1/engine/sessions",
      "/api/console/deploy-targets",
      "/api/console/builder/requests",
      "/acme/tools",
      "/assets/old.js",
    ]) {
      expect([url, (await get(url, owner.cookie)).status]).toEqual([url, 404]);
    }
    expect((await get("/api/console/guard/settings")).status).toBe(401);
    expect((await registry.consoleGet(owner, "/guard/settings")).status).toBe(200);
    expect((await registry.consoleWrite(member, "PUT", "/guard/settings", {})).status).toBe(403);
  });

  it("serves its own sign-in pages, enrols a laptop with a minted link, and refuses a console write with no Origin", async () => {
    for (const url of ["/login", "/start"]) {
      const res = await get(url);
      expect([url, res.status]).toEqual([url, 200]);
      expect(res.text).not.toContain("main console");
    }
    const { owner, member } = registry.people;
    const laptop = await enrolDevice(registry, owner, member, "member-mount");
    expect(laptop.token).toMatch(/^gdt_/);
    const denied = await page(`${registry.url}/api/console/guard/settings`, {
      method: "PUT",
      headers: { cookie: owner.cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(400);
    expect(String((JSON.parse(denied.text) as { detail?: unknown }).detail)).toContain("Origin");
  });
});
