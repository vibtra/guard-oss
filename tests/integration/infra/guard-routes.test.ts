import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistryServer, type RegistryServer } from "@vibtra/registry/src/server.js";
import { only, propertiesOf, synth } from "./synth.js";

const BOUNDARY_REFUSAL = '{"error":"Not part of Guard"}';
const LANDING_ASSET = "export const landing = 'made-up';\n";

describe("the routes the stack and the deploy checks rely on are doors the Guard server answers", () => {
  let server: RegistryServer;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "vibtra-infra-guard-routes-"));
    const landing = join(dataDir, "landing");
    const guardConsole = join(dataDir, "guard-console");
    await mkdir(join(landing, "assets"), { recursive: true });
    await mkdir(guardConsole, { recursive: true });
    await writeFile(join(landing, "index.html"), '<!doctype html><title>made-up landing</title><script type="module" src="/landing/assets/main-test01.js"></script>');
    await writeFile(join(landing, "assets", "main-test01.js"), LANDING_ASSET);
    await writeFile(join(guardConsole, "index.html"), "<!doctype html><title>made-up guard console</title>");
    server = await createRegistryServer({
      dataDir,
      landingDistDir: landing,
      guardConsoleDistDir: guardConsole,
      config: {
        mode: "hosted",
        hosted: {
          baseUrl: "http://registry.test.local",
          sessionSecret: "test-session-secret-0123456789abcdef0123456789",
          oidc: {
            issuer: "https://accounts.google.com",
            clientId: "test-google-client-id.apps.example",
            clientSecret: "test-google-client-secret-not-real",
          },
          vaultKey: "a".repeat(64),
        },
      },
    });
    base = await server.app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("answers the target group's health check path with the status its matcher expects", async () => {
    const group = propertiesOf(only((await synth()).registry, "AWS::ElasticLoadBalancingV2::TargetGroup")[1]);
    const matcher = group["Matcher"] as { HttpCode: string };
    const response = await fetch(new URL(String(group["HealthCheckPath"]), base));
    expect(String(response.status)).toBe(matcher.HttpCode);
  });

  it("answers the deploy workflow's checks /healthz, /login and / with 200", async () => {
    for (const path of ["/healthz", "/login", "/"]) {
      const response = await fetch(new URL(path, base), { redirect: "manual" });
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).not.toBe(BOUNDARY_REFUSAL);
    }
  });

  it("lets the landing's files under /landing/ and the Guard console at /:handle/guard through the product boundary", async () => {
    const asset = await fetch(new URL("/landing/assets/main-test01.js", base));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe(LANDING_ASSET);
    const page = await fetch(new URL("/acme/guard", base));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>made-up guard console</title>");
  });
});
