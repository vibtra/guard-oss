import { once } from "node:events";
import net from "node:net";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { catalogueDocument, contentRule, startOrigin, waitUntil, webSocketFrame, type Json, type Origin } from "./harness.ts";
import { activityRows, policyProfile, record, startRunning, useAgentSuite, viaProxy, type Reply, type Running } from "./running.ts";

const suite = useAgentSuite();
const TFN = contentRule("gcr_00000000000000c1", { kind: "au-tfn", requireContext: true });
const SECRET = contentRule("gcr_00000000000000c2", { kind: "secret" });
const LOOPBACK = catalogueDocument({
  version: "loopback-v1",
  services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["127.0.0.1"], bundleIds: [], cliNames: [], custom: true }],
});
const FILE_INSPECTION = { VIBTRA_GUARD_FILE_INSPECTION: "1" };
const MULTIPART = "multipart/form-data; boundary=b";
const FORM = "application/x-www-form-urlencoded;charset=UTF-8";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TFN_CSV = "name,note\nJane Citizen,My TFN is 123 456 782\n";
const CLEAN_CSV = "name,note\nJane Citizen,Prefers email\n";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const WIF_SHAPED_PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a00", "hex"), Buffer.from(`+5${BASE58.slice(0, 50)}+AAA`, "base64")]);

const u16 = (value: number): Buffer => {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
};

const u32 = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
};

const zip = (entries: readonly { name: string; data: string }[]): Buffer => {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = Buffer.from(entry.data);
    const packed = zlib.deflateRawSync(raw);
    const sizes = [u32(zlib.crc32(raw)), u32(packed.length), u32(raw.length), u16(name.length), u16(0)];
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u32(0), ...sizes, name, packed]);
    directory.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u32(0), ...sizes, u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(directory);
  return Buffer.concat([...locals, central, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]);
};

const docx = (paragraphs: readonly (readonly string[])[]): Buffer =>
  zip([
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    {
      name: "word/document.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
        .map((runs) => `<w:p>${runs.map((run) => `<w:r><w:t xml:space="preserve">${run}</w:t></w:r>`).join("")}</w:p>`)
        .join("")}</w:body></w:document>`,
    },
  ]);

const TFN_DOCX = docx([["Staff record"], ["My TFN is 123 4", "56 782"]]);
const CLEAN_DOCX = docx([["Staff record"], ["Prefers email"]]);

const multipart = (filename: string, type: string, data: Buffer | string): Buffer =>
  Buffer.concat([Buffer.from(`--b\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), Buffer.from(data), Buffer.from("\r\n--b--\r\n")]);

const base64Block = (type: string, mediaType: string, data: Buffer): Json => ({ type, source: { type: "base64", media_type: mediaType, data: data.toString("base64") } });

const claudeCode = (block: Json): string =>
  JSON.stringify({ model: "test-model", max_tokens: 1024, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_test", content: [block] }, { type: "text", text: "Summarise this file" }] }] });

const codexImage = (png: Buffer): string =>
  JSON.stringify({ type: "response.create", model: "test-model", input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` }, { type: "input_text", text: "What is in this image?" }] }] });

interface Rig {
  readonly agent: Running;
  readonly origin: Origin;
  send(contentType: string, body: Buffer | string, method?: string): Promise<Reply>;
}

const rig = async (fileInspection: boolean, clientMode: "enforce" | "monitor" = "enforce"): Promise<Rig> => {
  const origin = await startOrigin(suite.cleanup);
  const profile = await policyProfile(suite, { bundle: { clientMode, catalogueVersion: "loopback-v1", contentRules: [TFN, SECRET] }, catalogue: LOOPBACK });
  const agent = await startRunning(suite, profile, fileInspection ? { env: FILE_INSPECTION } : {});
  return {
    agent,
    origin,
    send: (contentType, body, method = "POST") => viaProxy(agent, { method, url: `${origin.url}/v1/upload`, headers: { "content-type": contentType, accept: "application/json" }, body }),
  };
};

const outcome = (reply: Reply): unknown[] => {
  if (reply.status !== 403) return [reply.status];
  const body = reply.json();
  const reasons = record(body.policy).reasons;
  const code = Array.isArray(reasons) ? record(reasons[0]).code : undefined;
  return code === "GUARD_CONTENT_BLOCKED" ? [403, code, body.ruleId] : [403, code];
};

const CONTENT_TFN = [403, "GUARD_CONTENT_BLOCKED", TFN.ruleId];
const UNREADABLE = [403, "GUARD_INSPECTION_UNAVAILABLE"];
const FORWARDED = [200];

interface Case {
  readonly name: string;
  readonly contentType: string;
  readonly body: Buffer | string;
  readonly method?: string;
  readonly expected: unknown[];
}

const expectCases = async (target: Rig, cases: readonly Case[]): Promise<void> => {
  for (const item of cases) {
    const before = target.origin.received.length;
    const reply = await target.send(item.contentType, item.body, item.method);
    expect(outcome(reply), item.name).toEqual(item.expected);
    const forwarded = target.origin.received.slice(before).map((request) => request.body);
    expect(forwarded, item.name).toEqual(item.expected === FORWARDED ? [Buffer.from(item.body)] : []);
  }
};

const latestFiles = async (agent: Running): Promise<unknown> => record((await activityRows(agent))[0]?.inspection).files;

interface WsOrigin {
  readonly port: number;
  received(): Buffer;
}

const startWsOrigin = async (): Promise<WsOrigin> => {
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) => {
    let head = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      if (head.includes("\r\n\r\n")) {
        chunks.push(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      chunks.push(head.subarray(end + 4));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  suite.cleanup.defer(async () => {
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the WebSocket origin has no port");
  return { port: address.port, received: () => Buffer.concat(chunks) };
};

const overWebSocket = async (agent: Running, origin: WsOrigin, message: string): Promise<number | "forwarded"> => {
  const socket = net.connect(agent.proxyPort, "127.0.0.1");
  await once(socket, "connect");
  socket.on("error", () => undefined);
  suite.cleanup.defer(async () => {
    socket.destroy();
  });
  let reply = Buffer.alloc(0);
  let closed = false;
  socket.on("data", (chunk: Buffer) => {
    reply = Buffer.concat([reply, chunk]);
  });
  socket.on("close", () => {
    closed = true;
  });
  const authority = `127.0.0.1:${origin.port}`;
  socket.write(`GET http://${authority}/ws HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nUser-Agent: Chrome\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await waitUntil("the WebSocket upgrade", async () => (reply.includes("\r\n\r\n") ? true : undefined));
  expect(reply.toString("latin1")).toMatch(/^HTTP\/1\.1 101 /);
  const frame = webSocketFrame(1, message);
  const before = origin.received().length;
  socket.write(frame);
  return waitUntil<number | "forwarded">("the message to be forwarded or refused", async () => {
    if (origin.received().length >= before + frame.length) return "forwarded";
    if (!closed) return undefined;
    return reply.subarray(reply.indexOf("\r\n\r\n") + 4).readUInt16BE(2);
  });
};

describe("with VIBTRA_GUARD_FILE_INSPECTION=1, Guard reads the files a request carries", () => {
  it("blocks a TFN in a file part, a base64 document block or a raw upload, and forwards clean files unchanged", async () => {
    const target = await rig(true);
    await expectCases(target, [
      { name: "multipart CSV", contentType: MULTIPART, body: multipart("staff.csv", "text/csv", TFN_CSV), expected: CONTENT_TFN },
      { name: "multipart CSV typed as binary", contentType: MULTIPART, body: multipart("staff.csv", "application/octet-stream", TFN_CSV), expected: CONTENT_TFN },
      { name: "multipart DOCX with the TFN split across runs", contentType: MULTIPART, body: multipart("staff.docx", DOCX, TFN_DOCX), expected: CONTENT_TFN },
      { name: "Claude Code base64 document block", contentType: "application/json", body: claudeCode(base64Block("document", DOCX, TFN_DOCX)), expected: CONTENT_TFN },
      { name: "raw text upload labelled as a form", contentType: FORM, body: TFN_CSV, expected: CONTENT_TFN },
      { name: "raw DOCX upload", contentType: "application/octet-stream", body: TFN_DOCX, method: "PUT", expected: CONTENT_TFN },
      { name: "clean multipart CSV", contentType: MULTIPART, body: multipart("notes.csv", "text/csv", CLEAN_CSV), expected: FORWARDED },
      { name: "clean multipart DOCX", contentType: MULTIPART, body: multipart("notes.docx", DOCX, CLEAN_DOCX), expected: FORWARDED },
      { name: "clean Claude Code document block", contentType: "application/json", body: claudeCode(base64Block("document", DOCX, CLEAN_DOCX)), expected: FORWARDED },
      { name: "clean raw upload labelled as a form", contentType: FORM, body: CLEAN_CSV, expected: FORWARDED },
      { name: "ordinary form", contentType: FORM, body: "prompt=hello&n=1", expected: FORWARDED },
    ]);
    const rows = await activityRows(target.agent);
    const files = rows.flatMap((row) => {
      const listed = record(row.inspection).files;
      return Array.isArray(listed) ? listed.map(record) : [];
    });
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) expect(Object.keys(file).sort()).toEqual(["bytes", "carrier", "coverage", "kind"]);
    expect(new Set(files.map((file) => file.carrier))).toEqual(new Set(["multipart", "json-base64", "raw"]));
    for (const forbidden of ["staff.", "notes.", "Jane Citizen", "Prefers email"]) expect(JSON.stringify(rows)).not.toContain(forbidden);
  });

  it("treats a clean base64 PNG as an unreadable file, not a leaked secret: refused in Enforce, recorded in Monitor", async () => {
    const body = claudeCode(base64Block("image", "image/png", WIF_SHAPED_PNG));
    const enforce = await rig(true);
    await expectCases(enforce, [{ name: "Enforce", contentType: "application/json", body, expected: UNREADABLE }]);
    expect(await latestFiles(enforce.agent)).toEqual([{ kind: "png", carrier: "json-base64", bytes: WIF_SHAPED_PNG.length, coverage: "unsupported" }]);

    const monitor = await rig(true, "monitor");
    await expectCases(monitor, [{ name: "Monitor", contentType: "application/json", body, expected: FORWARDED }]);
    const row = record((await activityRows(monitor.agent))[0]);
    expect([row.action, row.wouldAction, row.reason, row.ruleId, record(row.inspection).coverageFailure]).toEqual(["observed", "blocked", "http-coverage", undefined, true]);
  });

  it("refuses every file it identifies but cannot read, a zip bomb included, and keeps serving", async () => {
    const target = await rig(true);
    const bomb = zip([{ name: "word/document.xml", data: `<w:document><w:body><w:p><w:r><w:t>${" ".repeat(20 * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>` }]);
    const unreadable: [string, Buffer, string, string][] = [
      ["photo.png", WIF_SHAPED_PNG, "png", "unsupported"],
      ["photo.jpg", Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.alloc(32)]), "jpeg", "unsupported"],
      ["scan.pdf", Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n", "latin1"), "pdf", "unsupported"],
      ["locked.docx", Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(504)]), "ole", "unsupported"],
      ["archive.zip", zip([{ name: "notes.txt", data: "hello" }]), "zip", "unsupported"],
      ["broken.docx", Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(64, 0xff)]), "zip", "unsupported"],
      ["bomb.docx", bomb, "docx", "unreadable"],
    ];
    for (const [filename, data, kind, coverage] of unreadable) {
      await expectCases(target, [{ name: filename, contentType: MULTIPART, body: multipart(filename, "application/octet-stream", data), expected: UNREADABLE }]);
      expect(await latestFiles(target.agent), filename).toEqual([{ kind, carrier: "multipart", bytes: data.length, coverage }]);
    }
    await expectCases(target, [{ name: "after the bomb", contentType: MULTIPART, body: multipart("notes.csv", "text/csv", CLEAN_CSV), expected: FORWARDED }]);
  });

  it("reads the same carriers inside WebSocket messages", async () => {
    const profile = await policyProfile(suite, { bundle: { catalogueVersion: "loopback-v1", contentRules: [TFN, SECRET] }, catalogue: LOOPBACK });
    const agent = await startRunning(suite, profile, { env: FILE_INSPECTION });
    const origin = await startWsOrigin();
    expect(await overWebSocket(agent, origin, claudeCode(base64Block("document", DOCX, CLEAN_DOCX)))).toBe("forwarded");
    expect(await overWebSocket(agent, origin, claudeCode(base64Block("document", DOCX, TFN_DOCX)))).toBe(1008);
    expect(await overWebSocket(agent, origin, codexImage(WIF_SHAPED_PNG))).toBe(1008);
    const rows = (await activityRows(agent)).filter((row) => row.method === "WEBSOCKET");
    expect(rows.slice(0, 2).map((row) => [row.ruleId, row.reason, record(row.inspection).files])).toEqual([
      [undefined, "websocket-coverage", [{ kind: "png", carrier: "json-base64", bytes: WIF_SHAPED_PNG.length, coverage: "unsupported" }]],
      [TFN.ruleId, undefined, [{ kind: "docx", carrier: "json-base64", bytes: TFN_DOCX.length, coverage: "read" }]],
    ]);
  });
});

describe("without VIBTRA_GUARD_FILE_INSPECTION, Guard treats files as it does today", () => {
  it("false-blocks the base64 PNG on its base64 text, scans only text-typed file parts and never reads DOCX or raw form uploads", async () => {
    const target = await rig(false);
    await expectCases(target, [
      { name: "base64 PNG", contentType: "application/json", body: claudeCode(base64Block("image", "image/png", WIF_SHAPED_PNG)), expected: [403, "GUARD_CONTENT_BLOCKED", SECRET.ruleId] },
      { name: "multipart CSV", contentType: MULTIPART, body: multipart("staff.csv", "text/csv", TFN_CSV), expected: CONTENT_TFN },
      { name: "multipart CSV typed as binary", contentType: MULTIPART, body: multipart("staff.csv", "application/octet-stream", TFN_CSV), expected: FORWARDED },
      { name: "multipart DOCX", contentType: MULTIPART, body: multipart("staff.docx", DOCX, TFN_DOCX), expected: FORWARDED },
      { name: "raw text upload labelled as a form", contentType: FORM, body: TFN_CSV, expected: FORWARDED },
      { name: "multipart PNG", contentType: MULTIPART, body: multipart("photo.png", "image/png", WIF_SHAPED_PNG), expected: FORWARDED },
    ]);
    for (const row of await activityRows(target.agent)) expect(Object.keys(record(row.inspection))).not.toContain("files");
  });
});
