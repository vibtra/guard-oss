import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { catalogueDocument, connectFrame, contentRule, startOrigin, waitUntil, webSocketFrame, type Json, type Origin } from "./harness.ts";
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
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const SLIDE_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const TFN_CSV = "name,note\nJane Citizen,My TFN is 123 456 782\n";
const CLEAN_CSV = "name,note\nJane Citizen,Prefers email\n";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const WIF_SHAPED_PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a00", "hex"), Buffer.from(`+5${BASE58.slice(0, 50)}+AAA`, "base64")]);
const JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.alloc(32)]);
const PDF = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n", "latin1");
const SEVEN_Z = Buffer.concat([Buffer.from("377abcaf271c0004", "hex"), Buffer.alloc(24)]);
const RAR = Buffer.concat([Buffer.from("526172211a0700", "hex"), Buffer.alloc(24)]);
const ESCAPED_TFN_JSON = '{"note":"My TFN is \\u0031\\u0032\\u0033 456 782"}';
const FORM_PROMPTS: readonly (readonly [string, string])[] = [
  ["form with a valueless key", "prompt=My+TFN+is+123+456+782&stream"],
  ["form with a trailing newline", "prompt=My+TFN+is+123+456+782\n"],
];

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

interface Entry {
  readonly name: string;
  readonly data: Buffer | string;
}

const zip = (entries: readonly Entry[]): Buffer => {
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

const CONTENT_TYPES: Entry = { name: "[Content_Types].xml", data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` };

const docx = (paragraphs: readonly (readonly string[])[], extra: readonly Entry[] = [], padding = ""): Buffer =>
  zip([
    CONTENT_TYPES,
    {
      name: "word/document.xml",
      data: `${XML}<w:document xmlns:w="${WORD_NS}">${padding === "" ? "" : `<!--${padding}-->`}<w:body>${paragraphs
        .map((runs) => `<w:p>${runs.map((run) => `<w:r><w:t xml:space="preserve">${run}</w:t></w:r>`).join("")}</w:p>`)
        .join("")}</w:body></w:document>`,
    },
    ...extra,
  ]);

const xlsx = (rows: readonly (readonly (string | number)[])[], extra: readonly Entry[] = []): Buffer => {
  const shared = [...new Set(rows.flat().filter((value): value is string => typeof value === "string"))];
  const cell = (value: string | number): string => (typeof value === "number" ? `<c><v>${value}</v></c>` : `<c t="s"><v>${shared.indexOf(value)}</v></c>`);
  return zip([
    CONTENT_TYPES,
    { name: "xl/workbook.xml", data: `${XML}<workbook xmlns="${SHEET_NS}"><sheets><sheet name="Staff" sheetId="1"/></sheets></workbook>` },
    { name: "xl/worksheets/sheet1.xml", data: `${XML}<worksheet xmlns="${SHEET_NS}"><sheetData>${rows.map((row) => `<row>${row.map(cell).join("")}</row>`).join("")}</sheetData></worksheet>` },
    { name: "xl/sharedStrings.xml", data: `${XML}<sst xmlns="${SHEET_NS}">${shared.map((value) => `<si><t>${value}</t></si>`).join("")}</sst>` },
    ...extra,
  ]);
};

const pptx = (runs: readonly string[]): Buffer =>
  zip([
    CONTENT_TYPES,
    { name: "ppt/presentation.xml", data: `${XML}<p:presentation xmlns:p="${SLIDE_NS}"/>` },
    {
      name: "ppt/slides/slide1.xml",
      data: `${XML}<p:sld xmlns:p="${SLIDE_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree><p:sp><p:txBody><a:p>${runs.map((run) => `<a:r><a:t>${run}</a:t></a:r>`).join("")}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    },
  ]);

const TFN_DOCX = docx([["Staff record"], ["My TFN is 123 4", "56 782"]]);
const CLEAN_DOCX = docx([["Staff record"], ["Prefers email"]]);
const PADDED_DOCX = docx([["Prefers email"]], [], " ".repeat(4 * 1024 * 1024));
const PRINTER_SETTINGS: Entry = { name: "xl/printerSettings/printerSettings1.bin", data: Buffer.concat([Buffer.from("Office printer", "utf16le"), Buffer.from([0xff, 0xfe, 0x00, 0x01])]) };

interface Part {
  readonly name: string;
  readonly filename?: string;
  readonly type?: string;
  readonly data: Buffer | string;
}

const multipartParts = (parts: readonly Part[]): Buffer =>
  Buffer.concat([
    ...parts.flatMap((part) => [
      Buffer.from(`--b\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? "" : `; filename="${part.filename}"`}\r\n${part.type === undefined ? "" : `Content-Type: ${part.type}\r\n`}\r\n`),
      Buffer.from(part.data),
      Buffer.from("\r\n"),
    ]),
    Buffer.from("--b--\r\n"),
  ]);

const multipart = (filename: string, type: string, data: Buffer | string): Buffer => multipartParts([{ name: "file", filename, type, data }]);

const base64Block = (type: string, mediaType: string, data: Buffer): Json => ({ type, source: { type: "base64", media_type: mediaType, data: data.toString("base64") } });

const claudeCode = (block: Json): string =>
  JSON.stringify({ model: "test-model", max_tokens: 1024, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_test", content: [block] }, { type: "text", text: "Summarise this file" }] }] });

const codexImage = (png: Buffer): string =>
  JSON.stringify({ type: "response.create", model: "test-model", input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` }, { type: "input_text", text: "What is in this image?" }] }] });

interface Rig {
  readonly agent: Running;
  readonly origin: Origin;
  send(contentType: string, body: Buffer | string, method?: string, headers?: Readonly<Record<string, string>>): Promise<Reply>;
}

const rig = async (fileInspection: boolean, clientMode: "enforce" | "monitor" = "enforce"): Promise<Rig> => {
  const origin = await startOrigin(suite.cleanup);
  const profile = await policyProfile(suite, { bundle: { clientMode, catalogueVersion: "loopback-v1", contentRules: [TFN, SECRET] }, catalogue: LOOPBACK });
  const agent = await startRunning(suite, profile, fileInspection ? { env: FILE_INSPECTION } : {});
  return {
    agent,
    origin,
    send: (contentType, body, method = "POST", headers = {}) =>
      viaProxy(agent, { method, url: `${origin.url}/v1/upload`, headers: { "content-type": contentType, accept: "application/json", ...headers }, body }),
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
  readonly headers?: Readonly<Record<string, string>>;
  readonly expected: unknown[];
}

const expectCases = async (target: Rig, cases: readonly Case[]): Promise<void> => {
  for (const item of cases) {
    const before = target.origin.received.length;
    const reply = await target.send(item.contentType, item.body, item.method, item.headers);
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

const TFN_CSV_1252 = Buffer.from("name,note\nJosé Citizen,My TFN is 123 456 782\n", "latin1");
const CLEAN_CSV_1252 = Buffer.from("name,note\nJosé Citizen,Prefers email\n", "latin1");
const TFN_CSV_UTF16_BOM = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TFN_CSV, "utf16le")]);
const TFN_CSV_UTF16 = Buffer.from(TFN_CSV, "utf16le");
const BMP = Buffer.concat([Buffer.from("BM"), u32(70), u32(0), u32(54), u32(40), u32(2), u32(2), u16(1), u16(24), u32(0), u32(16), u32(2835), u32(2835), u32(0), u32(0), Buffer.alloc(16, 0xff)]);
const AVIF = Buffer.concat([Buffer.from("0000001c", "hex"), Buffer.from("ftypavif"), Buffer.alloc(4), Buffer.from("avifmif1miaf"), Buffer.alloc(32, 0xfe)]);
const UNKNOWN_BINARY = Buffer.concat([Buffer.from("0000000c", "hex"), Buffer.from("notes"), Buffer.alloc(8), Buffer.from("deadbeef", "hex")]);
const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const WORKBOOK: Entry = { name: "xl/workbook.xml", data: `${XML}<workbook xmlns="${SHEET_NS}"><sheets><sheet name="Staff" sheetId="1"/></sheets></workbook>` };
const ONE_CELL = "<sheetData><row><c><v>1</v></c></row></sheetData>";

const docxBody = (body: string, extra: readonly Entry[] = []): Buffer =>
  zip([CONTENT_TYPES, { name: "word/document.xml", data: `${XML}<w:document xmlns:w="${WORD_NS}" xmlns:wp="${WP_NS}"><w:body>${body}</w:body></w:document>` }, ...extra]);

const sheet = (inner: string, extra: readonly Entry[] = []): Buffer =>
  zip([CONTENT_TYPES, WORKBOOK, { name: "xl/worksheets/sheet1.xml", data: `${XML}<worksheet xmlns="${SHEET_NS}">${inner}</worksheet>` }, ...extra]);

const mimeParts = (subtype: string, parts: readonly { readonly type: string; readonly data: Buffer | string }[]): { contentType: string; body: Buffer } => ({
  contentType: `multipart/${subtype}; boundary=b`,
  body: Buffer.concat([...parts.flatMap((part) => [Buffer.from(`--b\r\nContent-Type: ${part.type}\r\n\r\n`), Buffer.from(part.data), Buffer.from("\r\n")]), Buffer.from("--b--\r\n")]),
});

const varint = (value: number): Buffer => {
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  out.push(rest);
  return Buffer.from(out);
};

const protoBytes = (field: number, data: Buffer | string): Buffer => Buffer.concat([varint((field << 3) | 2), varint(Buffer.byteLength(data)), Buffer.from(data)]);

const gemini = (key: "inlineData" | "inline_data", mimeType: string, data: Buffer): string =>
  JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Summarise this file" }, { [key]: { [key === "inlineData" ? "mimeType" : "mime_type"]: mimeType, data: data.toString("base64") } }] }] });

const inputFile = (fileData: string): string => JSON.stringify({ model: "test-model", input: [{ role: "user", content: [{ type: "input_file", file_data: fileData }, { type: "input_text", text: "Summarise this file" }] }] });

const streamThrough = async (agent: Running): Promise<string> => {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(request.method ?? "");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => response.writeHead(200, { "content-type": "text/plain" }).end(Buffer.concat(chunks)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  suite.cleanup.defer(async () => {
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the streaming origin has no port");
  const authority = `127.0.0.1:${address.port}`;
  const socket = net.connect(agent.proxyPort, "127.0.0.1");
  await once(socket, "connect");
  socket.on("error", () => undefined);
  suite.cleanup.defer(async () => {
    socket.destroy();
  });
  let reply = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    reply = Buffer.concat([reply, chunk]);
  });
  socket.write(`POST http://${authority}/v1/upload HTTP/1.1\r\nHost: ${authority}\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n`);
  await waitUntil("the origin to see the request while its body is still open", async () => (seen.length > 0 ? true : undefined), 10_000);
  socket.write("6\r\n world\r\n0\r\n\r\n");
  await waitUntil("the origin's reply", async () => (reply.includes("hello world") ? true : undefined), 10_000);
  return reply.toString("latin1").split("\r\n")[0] ?? "";
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
      ["photo.jpg", JPEG, "jpeg", "unsupported"],
      ["scan.pdf", PDF, "pdf", "unsupported"],
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

  it("reads an XLSX sheet as rows of cells, so a TFN header reaches the value under it, and reads PPTX slides", async () => {
    const target = await rig(true);
    await expectCases(target, [
      { name: "XLSX with a TFN column", contentType: MULTIPART, body: multipart("staff.xlsx", XLSX, xlsx([["Name", "TFN"], ["Jane Citizen", 123456782]])), expected: CONTENT_TFN },
      { name: "raw XLSX upload with a TFN column", contentType: "application/octet-stream", body: xlsx([["TFN"], [123456782]]), method: "PUT", expected: CONTENT_TFN },
      { name: "PPTX with the TFN split across runs", contentType: MULTIPART, body: multipart("staff.pptx", PPTX, pptx(["My TFN is 123 4", "56 782"])), expected: CONTENT_TFN },
      { name: "clean XLSX with printer settings", contentType: MULTIPART, body: multipart("notes.xlsx", XLSX, xlsx([["Name", "Note"], ["Jane Citizen", "Prefers email"]], [PRINTER_SETTINGS])), expected: FORWARDED },
      { name: "clean PPTX", contentType: MULTIPART, body: multipart("notes.pptx", PPTX, pptx(["Prefers email"])), expected: FORWARDED },
    ]);
  });

  it("reads every entry of an Office file: planted and embedded files are scanned, and an embedded image leaves the file unread", async () => {
    const target = await rig(true);
    const withImage = docx([["Staff record"]], [{ name: "word/media/image1.png", data: WIF_SHAPED_PNG }]);
    await expectCases(target, [
      { name: "DOCX with a planted CSV", contentType: MULTIPART, body: multipart("notes.docx", DOCX, docx([["Staff record"]], [{ name: "customers.csv", data: TFN_CSV }])), expected: CONTENT_TFN },
      { name: "DOCX with an embedded DOCX", contentType: MULTIPART, body: multipart("notes.docx", DOCX, docx([["Staff record"]], [{ name: "word/embeddings/Document1.docx", data: TFN_DOCX }])), expected: CONTENT_TFN },
      { name: "DOCX with an embedded image", contentType: MULTIPART, body: multipart("notes.docx", DOCX, withImage), expected: UNREADABLE },
    ]);
    expect(await latestFiles(target.agent)).toEqual([{ kind: "docx", carrier: "multipart", bytes: withImage.length, coverage: "unsupported" }]);
  });

  it("gives a request one inflate budget across all its files and keeps serving after it runs out", async () => {
    const target = await rig(true);
    const parts = Array.from({ length: 5 }, (_, index) => ({ name: `file${index}`, filename: `notes${index}.docx`, type: DOCX, data: PADDED_DOCX }));
    await expectCases(target, [
      { name: "one padded DOCX", contentType: MULTIPART, body: multipartParts(parts.slice(0, 1)), expected: FORWARDED },
      { name: "five padded DOCX", contentType: MULTIPART, body: multipartParts(parts), expected: UNREADABLE },
      { name: "after the budget ran out", contentType: MULTIPART, body: multipart("notes.csv", "text/csv", CLEAN_CSV), expected: FORWARDED },
    ]);
  });

  it("finds files in Connect JSON frames, unnamed multipart parts, compressed uploads and archives", async () => {
    const target = await rig(true);
    await expectCases(target, [
      { name: "Connect JSON frame with a base64 PNG", contentType: "application/connect+json", body: connectFrame(0, Buffer.from(claudeCode(base64Block("image", "image/png", WIF_SHAPED_PNG)))), expected: UNREADABLE },
    ]);
    expect(await latestFiles(target.agent)).toEqual([{ kind: "png", carrier: "json-base64", bytes: WIF_SHAPED_PNG.length, coverage: "unsupported" }]);
    await expectCases(target, [
      { name: "unnamed PDF part", contentType: MULTIPART, body: multipartParts([{ name: "upload", type: "application/pdf", data: PDF }]), expected: UNREADABLE },
      { name: "unnamed binary-typed CSV part", contentType: MULTIPART, body: multipartParts([{ name: "upload", type: "application/octet-stream", data: TFN_CSV }]), expected: CONTENT_TFN },
      { name: "unnamed untyped JPEG part", contentType: MULTIPART, body: multipartParts([{ name: "upload", data: JPEG }]), expected: UNREADABLE },
      { name: "gzip-encoded raw DOCX upload", contentType: DOCX, body: zlib.gzipSync(TFN_DOCX), method: "PUT", headers: { "content-encoding": "gzip" }, expected: CONTENT_TFN },
      { name: "raw .gz upload", contentType: "application/gzip", body: zlib.gzipSync(TFN_CSV), method: "PUT", expected: UNREADABLE },
      { name: "raw .7z upload", contentType: "application/octet-stream", body: SEVEN_Z, method: "PUT", expected: UNREADABLE },
      { name: "raw .rar upload", contentType: "application/octet-stream", body: RAR, method: "PUT", expected: UNREADABLE },
    ]);
  });

  it("keeps the JSON walk for named JSON parts and the form walk for form bodies that are not form-shaped", async () => {
    const target = await rig(true);
    await expectCases(target, [
      { name: "named JSON part with escaped digits", contentType: MULTIPART, body: multipart("notes.json", "application/json", ESCAPED_TFN_JSON), expected: CONTENT_TFN },
      ...FORM_PROMPTS.map(([name, body]) => ({ name, contentType: FORM, body, expected: CONTENT_TFN })),
    ]);
  });

  it("refuses a request when any one of its files is unread, and blocks a TFN typed beside a clean file", async () => {
    const target = await rig(true);
    const typedBesideBlock = JSON.stringify({ model: "test-model", max_tokens: 1024, messages: [{ role: "user", content: [base64Block("document", DOCX, CLEAN_DOCX), { type: "text", text: "My TFN is 123 456 782" }] }] });
    await expectCases(target, [
      {
        name: "clean CSV beside a PNG",
        contentType: MULTIPART,
        body: multipartParts([
          { name: "a", filename: "notes.csv", type: "text/csv", data: CLEAN_CSV },
          { name: "b", filename: "photo.png", type: "image/png", data: WIF_SHAPED_PNG },
        ]),
        expected: UNREADABLE,
      },
      {
        name: "TFN prompt beside a clean CSV",
        contentType: MULTIPART,
        body: multipartParts([
          { name: "prompt", data: "My TFN is 123 456 782" },
          { name: "file", filename: "notes.csv", type: "text/csv", data: CLEAN_CSV },
        ]),
        expected: CONTENT_TFN,
      },
      { name: "TFN prompt beside a clean document block", contentType: "application/json", body: typedBesideBlock, expected: CONTENT_TFN },
    ]);
  });

  it("decodes Windows-1252 and UTF-16 text, refuses bytes it cannot read, and parses every multipart subtype", async () => {
    const target = await rig(true);
    await expectCases(target, [
      { name: "Windows-1252 CSV labelled as a form", contentType: FORM, body: TFN_CSV_1252, expected: CONTENT_TFN },
      { name: "raw Windows-1252 CSV", contentType: "application/octet-stream", body: TFN_CSV_1252, method: "PUT", expected: CONTENT_TFN },
      { name: "Windows-1252 CSV in a named part", contentType: MULTIPART, body: multipart("staff.csv", "text/csv", TFN_CSV_1252), expected: CONTENT_TFN },
      { name: "clean Windows-1252 CSV in a named part", contentType: MULTIPART, body: multipart("notes.csv", "text/csv", CLEAN_CSV_1252), expected: FORWARDED },
      { name: "raw UTF-16 CSV with a BOM", contentType: "text/csv", body: TFN_CSV_UTF16_BOM, method: "PUT", expected: CONTENT_TFN },
      { name: "UTF-16 CSV with a BOM labelled as a form", contentType: FORM, body: TFN_CSV_UTF16_BOM, expected: CONTENT_TFN },
      { name: "UTF-16 CSV without a BOM in a named part", contentType: MULTIPART, body: multipart("staff.csv", "text/csv", TFN_CSV_UTF16), expected: CONTENT_TFN },
      { name: "UTF-16 CSV without a BOM in a base64 block", contentType: "application/json", body: claudeCode(base64Block("document", "text/csv", TFN_CSV_UTF16)), expected: CONTENT_TFN },
      { name: "one-line JSON text labelled as a form", contentType: FORM, body: '{"note":"My TFN is 123 456 782","link":"https://example.test/?id=7"}', expected: CONTENT_TFN },
      { name: "raw BMP", contentType: "image/bmp", body: BMP, method: "PUT", expected: UNREADABLE },
      { name: "BMP labelled as a form", contentType: FORM, body: BMP, expected: UNREADABLE },
      { name: "raw AVIF", contentType: "image/avif", body: AVIF, method: "PUT", expected: UNREADABLE },
      { name: "TFN DOCX in multipart/related", ...mimeParts("related", [{ type: "application/json; charset=UTF-8", data: '{"name":"notes"}' }, { type: DOCX, data: TFN_DOCX }]), expected: CONTENT_TFN },
      { name: "PNG in multipart/related", ...mimeParts("related", [{ type: "application/json; charset=UTF-8", data: '{"name":"notes"}' }, { type: "image/png", data: WIF_SHAPED_PNG }]), expected: UNREADABLE },
      { name: "TFN DOCX in multipart/mixed", ...mimeParts("mixed", [{ type: DOCX, data: TFN_DOCX }]), expected: CONTENT_TFN },
      { name: "clean CSV in multipart/mixed", ...mimeParts("mixed", [{ type: "text/csv", data: CLEAN_CSV }]), expected: FORWARDED },
      { name: "raw unknown binary", contentType: "application/octet-stream", body: UNKNOWN_BINARY, method: "PUT", expected: UNREADABLE },
    ]);
    expect(await latestFiles(target.agent)).toEqual([{ kind: "unknown", carrier: "raw", bytes: UNKNOWN_BINARY.length, coverage: "unreadable" }]);
  });

  it("finds base64 files in Gemini and MCP media fields and in leniently written base64, and refuses a carrier it cannot decode", async () => {
    const target = await rig(true);
    const base64 = TFN_DOCX.toString("base64");
    await expectCases(target, [
      { name: "Gemini inlineData DOCX", contentType: "application/json", body: gemini("inlineData", DOCX, TFN_DOCX), expected: CONTENT_TFN },
      { name: "Gemini inline_data JPEG", contentType: "application/json", body: gemini("inline_data", "image/jpeg", JPEG), expected: UNREADABLE },
      { name: "MCP image block", contentType: "application/json", body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "image", data: JPEG.toString("base64"), mimeType: "image/jpeg" }] }] }), expected: UNREADABLE },
      { name: "base64 block wrapped with spaces", contentType: "application/json", body: claudeCode({ type: "document", source: { type: "base64", media_type: DOCX, data: (base64.match(/.{1,76}/g) ?? []).join(" ") } }), expected: CONTENT_TFN },
      { name: "upper-case DATA: URL", contentType: "application/json", body: inputFile(`DATA:${DOCX};base64,${base64}`), expected: CONTENT_TFN },
      { name: "percent-encoded data URL", contentType: "application/json", body: inputFile(`data:${DOCX};base64,${encodeURIComponent(base64)}`), expected: CONTENT_TFN },
      { name: "base64 block that does not decode", contentType: "application/json", body: claudeCode({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "%% not base64 %%" } }), expected: UNREADABLE },
    ]);
  });

  it("keeps a base64 string in the text scan unless it decodes to a known binary format, so it never scans less than without the flag", async () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "text/plain", data: "KBBB".repeat(13) } }] }] });
    for (const fileInspection of [true, false]) {
      await expectCases(await rig(fileInspection), [{ name: `flag ${String(fileInspection)}`, contentType: "application/json", body, expected: [403, "GUARD_CONTENT_BLOCKED", SECRET.ruleId] }]);
    }
  });

  it("reads files in protobuf bytes fields, framed and unframed", async () => {
    const target = await rig(true);
    await expectCases(target, [
      { name: "connect+proto DOCX field", contentType: "application/connect+proto", body: connectFrame(0, Buffer.concat([protoBytes(1, "Summarise this file"), protoBytes(2, TFN_DOCX)])), expected: CONTENT_TFN },
      { name: "application/proto DOCX field", contentType: "application/proto", body: protoBytes(1, TFN_DOCX), expected: CONTENT_TFN },
      { name: "connect+proto PNG field", contentType: "application/connect+proto", body: connectFrame(0, Buffer.concat([protoBytes(1, "Summarise this image"), protoBytes(2, WIF_SHAPED_PNG)])), expected: UNREADABLE },
    ]);
    expect(await latestFiles(target.agent)).toEqual([{ kind: "png", carrier: "protobuf", bytes: WIF_SHAPED_PNG.length, coverage: "unsupported" }]);
  });

  it("reads Office text outside the body runs: alt text, link targets, tracked deletions, sheet headers, formulas and pivot caches", async () => {
    const target = await rig(true);
    const office: [string, string, Buffer][] = [
      ["DOCX picture alt text", DOCX, docxBody('<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="My TFN is 123 456 782"/></wp:inline></w:drawing></w:r></w:p>')],
      [
        "DOCX external link target",
        DOCX,
        docx([["Staff record"]], [{ name: "word/_rels/document.xml.rels", data: `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${HYPERLINK}" Target="https://example.test/?note=My%20TFN%20is%20123%20456%20782" TargetMode="External"/></Relationships>` }]),
      ],
      ["DOCX with a tracked deletion inside the number", DOCX, docxBody('<w:p><w:r><w:t xml:space="preserve">My TFN is 123 4</w:t></w:r><w:del w:id="1" w:author="Editor"><w:r><w:delText>99</w:delText></w:r></w:del><w:r><w:t>56 782</w:t></w:r></w:p>')],
      ["XLSX sheet header", XLSX, sheet(`${ONE_CELL}<headerFooter><oddHeader>&amp;CMy TFN is 123 456 782</oddHeader></headerFooter>`)],
      ["XLSX formula with no cached value", XLSX, sheet('<sheetData><row><c t="str"><f>"My TFN is 123 456 782"</f></c></row></sheetData>')],
      ["XLSX formula with a cached value", XLSX, sheet('<sheetData><row><c><f>LEN("My TFN is 123 456 782")</f><v>21</v></c></row></sheetData>')],
      [
        "XLSX pivot cache item",
        XLSX,
        sheet(ONE_CELL, [{ name: "xl/pivotCache/pivotCacheDefinition1.xml", data: `${XML}<pivotCacheDefinition xmlns="${SHEET_NS}"><cacheFields count="1"><cacheField name="Note"><sharedItems><s v="My TFN is 123 456 782"/></sharedItems></cacheField></cacheFields></pivotCacheDefinition>` }]),
      ],
    ];
    await expectCases(
      target,
      office.map(([name, type, data]) => ({ name, contentType: MULTIPART, body: multipart(type === DOCX ? "staff.docx" : "staff.xlsx", type, data), expected: CONTENT_TFN })),
    );
  });

  it("keeps the content rule's verdict when the request also carries a file it cannot read, as it does without the flag", async () => {
    const beside = multipartParts([
      { name: "prompt", data: "My TFN is 123 456 782" },
      { name: "file", filename: "photo.png", type: "image/png", data: WIF_SHAPED_PNG },
    ]);
    for (const fileInspection of [true, false]) {
      await expectCases(await rig(fileInspection), [{ name: `Enforce, flag ${String(fileInspection)}`, contentType: MULTIPART, body: beside, expected: CONTENT_TFN }]);
      const monitor = await rig(fileInspection, "monitor");
      await expectCases(monitor, [{ name: `Monitor, flag ${String(fileInspection)}`, contentType: MULTIPART, body: beside, expected: FORWARDED }]);
      expect(record((await activityRows(monitor.agent))[0]).ruleId, `Monitor, flag ${String(fileInspection)}`).toBe(TFN.ruleId);
    }
    const target = await rig(true);
    const message = JSON.stringify({ type: "response.create", model: "test-model", input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${WIF_SHAPED_PNG.toString("base64")}` }, { type: "input_text", text: "My TFN is 123 456 782" }] }] });
    expect(await overWebSocket(target.agent, await startWsOrigin(), message)).toBe(1008);
    expect((await activityRows(target.agent)).find((row) => row.method === "WEBSOCKET")?.ruleId).toBe(TFN.ruleId);
  });

  it("caps the text it extracts from a request's files, so a spreadsheet that expands past 4 MiB is refused quickly", async () => {
    const target = await rig(true);
    const bomb = sheet(`<sheetData><row>${'<c t="s"><v>0</v></c>'.repeat(384)}</row></sheetData>`, [
      { name: "xl/sharedStrings.xml", data: `${XML}<sst xmlns="${SHEET_NS}"><si><t>${"Prefers email ".repeat(4682).slice(0, 65536)}</t></si></sst>` },
    ]);
    const started = Date.now();
    await expectCases(target, [{ name: "shared-string bomb", contentType: MULTIPART, body: multipart("notes.xlsx", XLSX, bomb), expected: UNREADABLE }]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await latestFiles(target.agent)).toEqual([{ kind: "xlsx", carrier: "multipart", bytes: bomb.length, coverage: "unreadable" }]);
    await expectCases(target, [{ name: "after the bomb", contentType: MULTIPART, body: multipart("notes.csv", "text/csv", CLEAN_CSV), expected: FORWARDED }]);
  }, 120_000);

  it("streams an unknown-length binary body to the origin as it arrives, as it does without the flag", async () => {
    for (const fileInspection of [true, false]) {
      const target = await rig(fileInspection);
      expect(await streamThrough(target.agent), `file inspection ${String(fileInspection)}`).toBe("HTTP/1.1 200 OK");
    }
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

  it("scans data URL and WebSocket images and form and JSON prompts as text, and forwards raw binary uploads unread", async () => {
    const target = await rig(false);
    await expectCases(target, [
      { name: "data URL PNG", contentType: "application/json", body: codexImage(WIF_SHAPED_PNG), expected: [403, "GUARD_CONTENT_BLOCKED", SECRET.ruleId] },
      { name: "raw DOCX upload", contentType: "application/octet-stream", body: TFN_DOCX, method: "PUT", expected: FORWARDED },
      { name: "raw .gz upload", contentType: "application/gzip", body: zlib.gzipSync(TFN_CSV), method: "PUT", expected: FORWARDED },
      { name: "unnamed PDF part", contentType: MULTIPART, body: multipartParts([{ name: "upload", type: "application/pdf", data: PDF }]), expected: FORWARDED },
      { name: "named JSON part with escaped digits", contentType: MULTIPART, body: multipart("notes.json", "application/json", ESCAPED_TFN_JSON), expected: CONTENT_TFN },
      ...FORM_PROMPTS.map(([name, body]) => ({ name, contentType: FORM, body, expected: CONTENT_TFN })),
    ]);
    const origin = await startWsOrigin();
    expect(await overWebSocket(target.agent, origin, codexImage(WIF_SHAPED_PNG))).toBe(1008);
    const rows = await activityRows(target.agent);
    expect(rows.find((row) => row.method === "WEBSOCKET")?.ruleId).toBe(SECRET.ruleId);
    for (const row of rows) expect(Object.keys(record(row.inspection ?? {}))).not.toContain("files");
  });

  it("forwards the carriers the flag adds without reading them: raw unknown and BMP bytes, multipart/related, protobuf bytes fields and Windows-1252 forms", async () => {
    const target = await rig(false);
    await expectCases(target, [
      { name: "raw BMP", contentType: "image/bmp", body: BMP, method: "PUT", expected: FORWARDED },
      { name: "raw unknown binary", contentType: "application/octet-stream", body: UNKNOWN_BINARY, method: "PUT", expected: FORWARDED },
      { name: "TFN DOCX in multipart/related", ...mimeParts("related", [{ type: DOCX, data: TFN_DOCX }]), expected: FORWARDED },
      { name: "connect+proto DOCX field", contentType: "application/connect+proto", body: connectFrame(0, Buffer.concat([protoBytes(1, "Summarise this file"), protoBytes(2, TFN_DOCX)])), expected: FORWARDED },
      { name: "Windows-1252 CSV labelled as a form", contentType: FORM, body: TFN_CSV_1252, expected: FORWARDED },
    ]);
    for (const row of await activityRows(target.agent)) expect(Object.keys(record(row.inspection))).not.toContain("files");
  });
});
