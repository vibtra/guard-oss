import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http2, { type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { catalogueDocument, contentRule, tempDir } from "../../integration/agent-go/harness.ts";
import { helloShape, isGrease, readHello, UNSAFE_EXTENSIONS, type HelloShape } from "../../integration/agent-go/hello.ts";
import { local, policyProfile, record, startRunning, useAgentSuite, type Running } from "../../integration/agent-go/running.ts";

const suite = useAgentSuite();
const exec = promisify(execFile);
const CHAT = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true }] });
const TFN = contentRule("gcr_00000000000000c1", { kind: "au-tfn", requireContext: true });
const SENSITIVE = '{"messages":[{"content":"My TFN is 123 456 782"}]}';
const PROXY_VARIABLES = new Set(["http_proxy", "https_proxy", "all_proxy", "no_proxy"]);

interface Hello {
  readonly phase: string;
  readonly shape: HelloShape;
}

interface Served {
  readonly phase: string;
  readonly method: string;
  readonly path: string;
  readonly httpVersion: string;
}

interface Origin {
  readonly port: number;
  readonly hellos: Hello[];
  readonly served: Served[];
  phase: string;
}

interface Matrix {
  readonly origin: Origin;
  readonly agent: Running;
  readonly caBundle: string;
  readonly chrome: string;
}

interface Call {
  readonly via: boolean;
  readonly blocked: boolean;
}

interface Client {
  readonly name: string;
  readonly sortExtensions: boolean;
  readonly run: (matrix: Matrix, call: Call) => Promise<string>;
  readonly confirmsBlock: (output: string) => boolean;
}

const testCertificates = async (): Promise<{ caPath: string; cert: string; key: string }> => {
  const dir = await tempDir(suite.cleanup, "matrix-ca");
  const file = (name: string): string => path.join(dir, name);
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  await exec("openssl", ["req", "-x509", ...ec, "-subj", "/CN=Guard capture matrix test CA", "-days", "1", "-keyout", file("ca.key"), "-out", file("ca.pem"), "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-addext", "subjectKeyIdentifier=hash"]);
  await exec("openssl", ["req", "-new", ...ec, "-subj", "/CN=chatgpt.com", "-keyout", file("leaf.key"), "-out", file("leaf.csr")]);
  await writeFile(file("leaf.ext"), "subjectAltName=DNS:chatgpt.com\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n");
  await exec("openssl", ["x509", "-req", "-in", file("leaf.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"), "-CAcreateserial", "-days", "1", "-extfile", file("leaf.ext"), "-out", file("leaf.pem")]);
  return { caPath: file("ca.pem"), cert: await readFile(file("leaf.pem"), "utf8"), key: await readFile(file("leaf.key"), "utf8") };
};

const BLOCK_PAGE = `<!doctype html><body>waiting<script>fetch('/backend-api/conversation',{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(SENSITIVE)}}).then(async (r)=>{const b=await r.text();document.body.textContent=r.status===403&&b.includes('GUARD_BLOCKED')?'matrix-block-ok':'matrix-block-failed '+r.status}).catch((e)=>{document.body.textContent='matrix-block-error '+e})</script>`;

const startCapturingOrigin = async (cert: string, key: string): Promise<Origin> => {
  const hellos: Hello[] = [];
  const served: Served[] = [];
  const tlsServer = http2.createSecureServer({ cert, key, allowHTTP1: true }, (request: Http2ServerRequest, response: Http2ServerResponse) => {
    served.push({ phase: origin.phase, method: request.method, path: request.url, httpVersion: request.httpVersion });
    request.resume();
    request.once("end", () => {
      if (request.method === "GET" && request.url === "/matrix-block") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(BLOCK_PAGE);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>matrix-ok</title><p>matrix-ok ${request.httpVersion}</p>`);
    });
  });
  tlsServer.on("tlsClientError", () => undefined);
  const server = net.createServer((socket) => {
    let received = Buffer.alloc(0);
    socket.on("error", () => undefined);
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      let parsed: ReturnType<typeof readHello>;
      try {
        parsed = readHello(received);
      } catch {
        socket.destroy();
        return;
      }
      if (parsed === undefined) return;
      socket.off("data", onData);
      socket.pause();
      hellos.push({ phase: origin.phase, shape: helloShape(parsed.handshake) });
      socket.unshift(received);
      tlsServer.emit("connection", socket);
    };
    socket.on("data", onData);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  suite.cleanup.defer(async () => {
    server.close();
    tlsServer.close();
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the capturing origin has no port");
  const origin: Origin = { port: address.port, hellos, served, phase: "startup" };
  return origin;
};

const u16s = (data: Buffer | undefined, from: number): number[] => {
  if (data === undefined) return [];
  const values: number[] = [];
  for (let at = from; at + 1 < data.length; at += 2) values.push(data.readUInt16BE(at));
  return values.filter((value) => !isGrease(value));
};

const extensionData = (shape: HelloShape, type: number): Buffer | undefined => shape.extensions.find((item) => item.type === type)?.data;

const fingerprint = (shape: HelloShape, sortExtensions: boolean): string => {
  const extensions = shape.extensions.map((item) => item.type).filter((type) => !isGrease(type) && !UNSAFE_EXTENSIONS.includes(type));
  const suites = shape.suites.filter((suite) => !isGrease(suite));
  return JSON.stringify({
    version: shape.version,
    suites: sortExtensions ? [...suites].sort((a, b) => a - b) : suites,
    extensions: sortExtensions ? [...extensions].sort((a, b) => a - b) : extensions,
    groups: u16s(extensionData(shape, 10), 2),
    pointFormats: [...(extensionData(shape, 11)?.subarray(1) ?? [])],
    signatureAlgorithms: u16s(extensionData(shape, 13), 2),
    supportedVersions: u16s(extensionData(shape, 43), 1),
    alpn: shape.alpn,
    serverName: shape.serverName,
  });
};

const clientEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !PROXY_VARIABLES.has(name.toLowerCase())));

const runClient = async (command: string, args: readonly string[], timeoutMs = 60_000): Promise<string> => {
  try {
    const { stdout, stderr } = await exec(command, args, { env: clientEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return `${stdout}${stderr}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${path.basename(command)} failed: ${detail}`, { cause: error });
  }
};

const target = (matrix: Matrix, blocked: boolean): string => `https://chatgpt.com:${matrix.origin.port}${blocked ? "/backend-api/conversation" : "/matrix"}`;
const proxyUrl = (matrix: Matrix): string => `http://127.0.0.1:${matrix.agent.proxyPort}`;

const curlClient = (name: string, flag: string): Client => ({
  name,
  sortExtensions: false,
  run: (matrix, call) =>
    runClient("curl", [
      "-sS",
      "--max-time",
      "20",
      "--cacert",
      matrix.caBundle,
      flag,
      ...(call.blocked ? ["-H", "Content-Type: application/json", "--data-binary", SENSITIVE, "-w", "\nstatus:%{http_code}"] : ["--fail"]),
      ...(call.via ? ["--proxy", proxyUrl(matrix), "--noproxy", ""] : ["--noproxy", "*", "--resolve", `chatgpt.com:${matrix.origin.port}:127.0.0.1`]),
      target(matrix, call.blocked),
    ]),
  confirmsBlock: (output) => output.includes("status:403") && output.includes("GUARD_BLOCKED"),
});

const PYTHON_REQUESTS = `import requests, socket, sys
url, ca, proxy, payload = sys.argv[1:]
original = socket.getaddrinfo
def local_dns(host, port, *rest, **options):
    return original("127.0.0.1" if host == "chatgpt.com" else host, port, *rest, **options)
socket.getaddrinfo = local_dns
proxies = {"https": proxy} if proxy else None
if payload:
    reply = requests.post(url, data=payload, headers={"Content-Type": "application/json"}, verify=ca, proxies=proxies, timeout=15)
    if reply.status_code != 403 or "GUARD_BLOCKED" not in reply.text:
        sys.exit("POST answered %d: %s" % (reply.status_code, reply.text[:200]))
    print("matrix-block-ok")
else:
    reply = requests.get(url, verify=ca, proxies=proxies, timeout=15)
    reply.raise_for_status()
    print(reply.text)
`;

const PYTHON_URLLIB = `import socket, ssl, sys, urllib.error, urllib.request
url, ca, proxy, payload = sys.argv[1:]
original = socket.getaddrinfo
def local_dns(host, port, *rest, **options):
    return original("127.0.0.1" if host == "chatgpt.com" else host, port, *rest, **options)
socket.getaddrinfo = local_dns
opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": proxy} if proxy else {}), urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=ca)))
if payload:
    try:
        opener.open(urllib.request.Request(url, data=payload.encode(), headers={"Content-Type": "application/json"}), timeout=15)
    except urllib.error.HTTPError as error:
        body = error.read()
        if error.code != 403 or b"GUARD_BLOCKED" not in body:
            sys.exit("POST answered %d: %r" % (error.code, body[:200]))
        print("matrix-block-ok")
    else:
        sys.exit("POST was allowed")
else:
    print(opener.open(url, timeout=15).read().decode())
`;

const pythonClient = (name: string, script: string): Client => ({
  name,
  sortExtensions: false,
  run: (matrix, call) => runClient("python3", ["-c", script, target(matrix, call.blocked), matrix.caBundle, call.via ? proxyUrl(matrix) : "", call.blocked ? SENSITIVE : ""]),
  confirmsBlock: (output) => output.includes("matrix-block-ok"),
});

const NODE_HTTPS = `const http = require("node:http"), tls = require("node:tls"), fs = require("node:fs");
const [target, caFile, proxy, payload] = process.argv.slice(1);
const url = new URL(target), ca = fs.readFileSync(caFile);
const fail = (error) => { console.error(String(error)); process.exit(1); };
const secure = (options) => tls.connect({ ...options, servername: url.hostname, ca, ALPNProtocols: ["http/1.1"] });
const send = (createConnection) => {
  const request = http.request({ method: payload ? "POST" : "GET", path: url.pathname, createConnection, headers: { host: url.host, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) } }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => {
      if (payload) {
        if (response.statusCode !== 403 || !body.includes("GUARD_BLOCKED")) fail("POST answered " + response.statusCode + ": " + body.slice(0, 200));
        console.log("matrix-block-ok");
        return;
      }
      if (response.statusCode !== 200) fail("GET answered " + response.statusCode);
      console.log(body);
    });
  });
  request.on("error", fail);
  request.end(payload || undefined);
};
if (!proxy) send(() => secure({ host: "127.0.0.1", port: Number(url.port) }));
else {
  const proxied = new URL(proxy);
  const connect = http.request({ host: proxied.hostname, port: proxied.port, method: "CONNECT", path: url.host, headers: { host: url.host }, agent: false });
  connect.on("connect", (response, socket) => {
    if (response.statusCode !== 200) fail("CONNECT answered " + response.statusCode);
    send(() => secure({ socket }));
  });
  connect.on("error", fail);
  connect.end();
}
`;

const nodeClient: Client = {
  name: "node https",
  sortExtensions: false,
  run: (matrix, call) => runClient(process.execPath, ["-e", NODE_HTTPS, target(matrix, call.blocked), matrix.caBundle, call.via ? proxyUrl(matrix) : "", call.blocked ? SENSITIVE : ""]),
  confirmsBlock: (output) => output.includes("matrix-block-ok"),
};

const chromeClient: Client = {
  name: "headless Chrome",
  sortExtensions: true,
  run: async (matrix, call) => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "guard-matrix-chrome-"));
    try {
      return await runClient(matrix.chrome, [
        "--headless=new",
        "--disable-gpu",
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-extensions",
        "--no-pings",
        `--user-data-dir=${profile}`,
        "--host-resolver-rules=MAP chatgpt.com 127.0.0.1",
        "--ignore-certificate-errors",
        "--timeout=20000",
        "--virtual-time-budget=5000",
        ...(call.via ? [`--proxy-server=${proxyUrl(matrix)}`, "--proxy-bypass-list=<-loopback>"] : ["--no-proxy-server"]),
        "--dump-dom",
        `https://chatgpt.com:${matrix.origin.port}${call.blocked ? "/matrix-block" : "/matrix"}`,
      ]);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
  confirmsBlock: (output) => output.includes("<body>matrix-block-ok</body>"),
};

const CLIENTS: readonly Client[] = [curlClient("curl --http1.1", "--http1.1"), curlClient("curl --http2", "--http2"), pythonClient("python requests", PYTHON_REQUESTS), pythonClient("python urllib", PYTHON_URLLIB), nodeClient, chromeClient];

const onPath = (name: string): string | undefined => {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
};

const findChrome = (): string => {
  const configured = process.env.GUARD_MATRIX_CHROME;
  if (configured !== undefined && configured !== "") return configured;
  const found = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map(onPath).find((item) => item !== undefined);
  if (found === undefined) throw new Error("headless Chrome is not installed: set GUARD_MATRIX_CHROME to a Chrome binary");
  accessSync(found, constants.X_OK);
  return found;
};

const transport = async (agent: Running): Promise<{ readonly uninspected: unknown; readonly tunnelled: unknown; readonly lastHello: unknown }> => {
  const status = record((await local(agent, "/status")).json().upstreamTransport);
  return { uninspected: status.uninspectedConnections, tunnelled: status.tunnelledConnections, lastHello: status.lastClientHelloSHA256 };
};

describe("real clients through the built agent, compared with the same clients straight to the origin", () => {
  let matrix: Matrix;

  beforeAll(async () => {
    for (const binary of ["curl", "python3", "openssl"]) {
      if (onPath(binary) === undefined) throw new Error(`the capture matrix needs ${binary} on PATH`);
    }
    await runClient("python3", ["-c", "import requests"]);
    const chrome = findChrome();
    const certificates = await testCertificates();
    const origin = await startCapturingOrigin(certificates.cert, certificates.key);
    const profile = await policyProfile(suite, { bundle: { contentRules: [TFN] }, catalogue: CHAT });
    const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": `https://127.0.0.1:${origin.port}` }, args: ["--upstream-ca", certificates.caPath] });
    const caBundle = path.join(await tempDir(suite.cleanup, "matrix-bundle"), "ca-bundle.pem");
    await writeFile(caBundle, `${await readFile(certificates.caPath, "utf8")}\n${agent.caPem}`);
    matrix = { origin, agent, caBundle, chrome };
  }, 300_000);

  const capture = async (phase: string, call: Call, client: Client): Promise<{ output: string; hellos: string[]; versions: string[] }> => {
    matrix.origin.phase = phase;
    const output = await client.run(matrix, call);
    await delay(300);
    return {
      output,
      hellos: matrix.origin.hellos.filter((hello) => hello.phase === phase).map((hello) => fingerprint(hello.shape, client.sortExtensions)),
      versions: matrix.origin.served.filter((served) => served.phase === phase && served.path === "/matrix").map((served) => served.httpVersion),
    };
  };

  for (const client of CLIENTS) {
    it(`${client.name} sends the same ClientHello and negotiates the same HTTP version through the agent, and a TFN POST is refused before the origin`, { timeout: 180_000 }, async () => {
      const direct = await capture(`${client.name} direct`, { via: false, blocked: false }, client);
      const via = await capture(`${client.name} via`, { via: true, blocked: false }, client);
      expect(direct.output, "direct reply").toContain("matrix-ok");
      expect(via.output, "reply through the agent").toContain("matrix-ok");
      expect(direct.hellos.length, "direct hellos").toBeGreaterThan(0);
      expect(via.hellos.length, "hellos through the agent").toBeGreaterThan(0);
      if (client.sortExtensions) expect([...new Set(via.hellos)].sort(), "hello set through the agent").toEqual([...new Set(direct.hellos)].sort());
      else expect(via.hellos, "hellos through the agent").toEqual(direct.hellos);
      expect(direct.versions.length, "direct requests").toBeGreaterThan(0);
      expect([...new Set(via.versions)], "HTTP version through the agent").toEqual([...new Set(direct.versions)]);
      expect(await transport(matrix.agent)).toMatchObject({ uninspected: 0, tunnelled: 0 });

      const postsBefore = matrix.origin.served.filter((served) => served.method === "POST").length;
      const blocked = await capture(`${client.name} blocked`, { via: true, blocked: true }, client);
      expect(client.confirmsBlock(blocked.output), `the block reply: ${blocked.output.slice(-400)}`).toBe(true);
      expect(matrix.origin.served.filter((served) => served.method === "POST")).toHaveLength(postsBefore);
      const after = await transport(matrix.agent);
      expect([after.uninspected, after.tunnelled]).toEqual([0, 0]);
      expect(after.lastHello).toMatch(/^[0-9a-f]{64}$/);
    });
  }
});
