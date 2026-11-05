import { mkdtempSync, rmSync } from "node:fs";
import https from "node:https";
import type { Server } from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface GatewayMaterial {
  key: Buffer;
  cert: Buffer;
  ca: Buffer;
}

interface InjectedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  payload: Buffer;
}

interface GatewayModule {
  prepareGateway(directory: string, host: string): GatewayMaterial;
  createGateway(options: GatewayMaterial & { inject: (request: InjectedRequest) => Promise<{ statusCode: number; body: string }> }): Server;
  listenGateway(server: Server, options: { host: string; port: number }): Promise<number>;
}

interface GatewayReply {
  status: number;
  body: string;
}

const gatewayModule = pathToFileURL(fileURLToPath(new URL("../../../scripts/lib/guard-guest-gateway.mjs", import.meta.url))).href;

const ENROL = "/api/guard/v1/enrol";
const PAYLOAD = Buffer.concat([
  Buffer.from('{"enrolment":"gdev-example","note":"café ☃ \u{1F512}"}', "utf8"),
  Buffer.from([0x00, 0x0a, 0x0d, 0x7f, 0x80, 0xfe, 0xff]),
]);

let work = "";
let server: Server | undefined;
let port = 0;
let ca: Buffer = Buffer.alloc(0);
const recorded: InjectedRequest[] = [];

const post = (pathname: string, headers: Record<string, string>, body: Buffer): Promise<GatewayReply> =>
  new Promise((resolve, reject) => {
    const request = https.request(
      { host: "127.0.0.1", port, path: pathname, method: "POST", ca, headers: { ...headers, "content-length": String(body.length) } },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(parts).toString("utf8") }));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });

beforeAll(async () => {
  const gateway = (await import(gatewayModule)) as GatewayModule;
  work = mkdtempSync(path.join(os.tmpdir(), "guard-guest-gateway-"));
  const material = gateway.prepareGateway(path.join(work, "prepared"), "127.0.0.1");
  ca = material.ca;
  server = gateway.createGateway({
    ...material,
    inject: (request) => {
      recorded.push(request);
      return Promise.resolve({ statusCode: 201, body: '{"enrolled":"gdev-example"}' });
    },
  });
  port = await gateway.listenGateway(server, { host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  const listening = server;
  if (listening?.listening) {
    await new Promise<void>((resolve) => {
      listening.closeAllConnections();
      listening.close(() => resolve());
    });
  }
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

describe("guard-guest-gateway.mjs on loopback", () => {
  it("strips cookie and x-forwarded-host and forwards the enrol payload byte for byte", async () => {
    const reply = await post(
      ENROL,
      {
        cookie: "vibtra.session=browser-cookie-not-forwarded",
        "x-forwarded-host": "attacker.example.test",
        "x-forwarded-for": "203.0.113.9",
        "content-type": "application/json",
        authorization: "Bearer gateway-test-bearer",
      },
      PAYLOAD,
    );

    expect(reply).toEqual({ status: 201, body: '{"enrolled":"gdev-example"}' });
    expect(recorded).toHaveLength(1);
    const [forwarded] = recorded;
    expect(forwarded?.method).toBe("POST");
    expect(forwarded?.url).toBe(ENROL);
    expect(forwarded?.headers.cookie).toBeUndefined();
    expect(forwarded?.headers["x-forwarded-host"]).toBeUndefined();
    expect(forwarded?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer gateway-test-bearer",
      "content-type": "application/json",
    });
    expect(Buffer.isBuffer(forwarded?.payload)).toBe(true);
    expect(forwarded?.payload.equals(PAYLOAD)).toBe(true);
  });

  it("forwards an empty JSON object as exactly those two bytes", async () => {
    recorded.length = 0;
    const reply = await post(ENROL, { cookie: "not-forwarded", "x-forwarded-host": "not-forwarded", "content-type": "application/json" }, Buffer.from("{}"));
    expect(reply.status).toBe(201);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.headers.cookie).toBeUndefined();
    expect(recorded[0]?.headers["x-forwarded-host"]).toBeUndefined();
    expect(recorded[0]?.payload.toString("utf8")).toBe("{}");
  });
});
