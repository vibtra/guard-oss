import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConsoleModule, type ConsoleModule } from "./load-console-module.ts";

type Client = {
  call: (schema: { safeParse: (value: unknown) => { success: true; data: unknown } }, path: string) => Promise<unknown>;
  refusalWords: (error: unknown, next?: string) => string;
  ConsoleApiError: new (args: { status: number; code: string; message: string }) => Error & { traceId?: string };
};

let client: ConsoleModule<Client>;
const TRACE = "01a1e141-caf1-70df-a384-34ddc8c18cef";

beforeAll(async () => {
  client = await loadConsoleModule<Client>("/src/api/client.ts");
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await client?.close();
});

const failWith = async (body: unknown, headers: Record<string, string> = {}): Promise<Error & { traceId?: string }> => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 500, headers: { "content-type": "application/json", ...headers } }));
  try {
    await client.module.call({ safeParse: (value) => ({ success: true, data: value }) }, "/guard/overview");
  } catch (error) {
    return error as Error & { traceId?: string };
  }
  throw new Error("the call did not fail");
};

describe("the console carries the registry's traceId into what it shows", () => {
  it("reads traceId from the error body, falls back to the x-request-id header, and names it in the refusal", async () => {
    const fromBody = await failWith({ code: "INTERNAL", message: "Something went wrong", traceId: TRACE });
    expect(fromBody.traceId).toBe(TRACE);
    expect(client.module.refusalWords(fromBody)).toBe(`Something went wrong. Try again. Reference ${TRACE}.`);

    const fromHeader = await failWith({ code: "INTERNAL", message: "Something went wrong" }, { "x-request-id": "edge-trace-0001" });
    expect(fromHeader.traceId).toBe("edge-trace-0001");

    const none = await failWith({ code: "INTERNAL", message: "Something went wrong" });
    expect(client.module.refusalWords(none)).toBe("Something went wrong. Try again.");
  });
});
