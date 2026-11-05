#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `usage: node scripts/self-host-walk.mjs --guest USER@HOST --link-file FILE [options]

Enrols a real Guard agent inside a guest Mac against your self-hosted server, then sends one normal, one blocked
and one normal prompt through it. The agent runs in an isolated profile in ~/guard-selfhost-walk on the guest:
no system proxy, certificate trust, keychain or Network Extension change on the guest or on this host.

  --guest USER@HOST     the guest Mac, reachable over SSH with a key (BatchMode)
  --link-file FILE      a file (mode 600) holding the enrol link copied from Devices; never printed
  --host-port PORT      where the server listens on this host (default: the link's port, or 4700)
  --keyword WORD        the keyword of the synthetic content rule (default PROJECT-NIGHTJAR)
  --compose-env FILE    the server's env file (repeat for several, in Compose order); adds read-only Postgres
                        checks through Docker Compose
  --project NAME        the Compose project name (default guard)
  --out FILE            write the result as JSON (no token, no prompt text)
  --keep-agent          leave the guest agent and its tunnel running after the walk`;

const { values: opts } = parseArgs({
  options: {
    guest: { type: "string" },
    "link-file": { type: "string" },
    "host-port": { type: "string" },
    keyword: { type: "string", default: "PROJECT-NIGHTJAR" },
    "compose-env": { type: "string", multiple: true },
    project: { type: "string", default: "guard" },
    out: { type: "string" },
    "keep-agent": { type: "boolean", default: false },
    "mock-guest-port": { type: "string", default: "4719" },
    help: { type: "boolean", default: false },
  },
});

const say = (line) => console.log(`[self-host-walk] ${line}`);
const fail = (line) => {
  throw new Error(line);
};
const check = (ok, what) => {
  if (!ok) fail(`FAILED: ${what}`);
  say(`ok  ${what}`);
};

if (opts.help || !opts.guest || !opts["link-file"]) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 2);
}
if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(opts.guest)) fail("--guest must look like user@host");
if (!/^[A-Za-z0-9_-]{3,64}$/.test(opts.keyword)) fail("--keyword must be 3 to 64 letters, digits, - or _");

const linkFile = path.resolve(opts["link-file"].replace(/^~(?=\/)/, os.homedir()));
const linkMode = statSync(linkFile).mode & 0o777;
if ((linkMode & 0o077) !== 0) fail(`${linkFile} is readable by others (mode ${linkMode.toString(8)}); chmod 600 it first`);
const link = readFileSync(linkFile, "utf8").trim();
let server;
try {
  const parsed = new URL(link);
  if (parsed.protocol !== "vibtra-guard:" || parsed.searchParams.get("token") === null) throw new Error("not an enrol link");
  server = new URL(parsed.searchParams.get("server") ?? "");
} catch {
  fail(`${linkFile} does not hold an enrol link (vibtra-guard://enrol?server=…&token=…). Copy it from Devices → Enrol link.`);
}
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(server.hostname);
if (server.protocol !== "https:" && !(server.protocol === "http:" && loopback)) fail(`the link's server ${server.origin} is neither https nor loopback`);
const guestServerPort = Number(server.port || (server.protocol === "https:" ? 443 : 80));
const hostPort = Number(opts["host-port"] ?? (loopback ? guestServerPort : 0));
const mockGuestPort = Number(opts["mock-guest-port"]);

const work = mkdtempSync(path.join(os.tmpdir(), "guard-self-host-walk-"));
const sockets = mkdtempSync(path.join(os.platform() === "darwin" ? "/tmp" : os.tmpdir(), "gsw-"));
const CONTROL = path.join(sockets, "cm");
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ControlMaster=no", "-o", `ControlPath=${CONTROL}`];
const ssh = (args, input) => {
  let res;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    res = spawnSync("ssh", [...SSH_OPTS, opts.guest, ...args], { input, encoding: "utf8", timeout: 120_000 });
    if (res.status !== 255) break;
    spawnSync("sleep", ["1"]);
  }
  if (res.status !== 0) fail(`ssh ${args.join(" ").slice(0, 80)} failed (${res.status}): ${(res.stderr || res.stdout).trim().slice(-400)}`);
  return res.stdout;
};
const sshOnce = (args, input) =>
  new Promise((resolve) => {
    const child = spawn("ssh", [...SSH_OPTS, opts.guest, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.once("error", (e) => resolve({ code: -1, out, err: e.message }));
    child.once("exit", (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? "");
  });
const sshAsync = async (args, input) => {
  let res;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    res = await sshOnce(args, input);
    if (res.code !== 255) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (res.code !== 0) fail(`ssh ${args.join(" ").slice(0, 80)} failed (${res.code}): ${(res.err || res.out).trim().slice(-400)}`);
  return res.out;
};
const compose = (args, input) => {
  const res = spawnSync("docker", ["compose", "-p", opts.project, "-f", path.join(ROOT, "apps/registry/docker-compose.yml"), ...opts["compose-env"].flatMap((file) => ["--env-file", file]), ...args], { cwd: ROOT, input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) fail(`docker compose ${args.slice(0, 3).join(" ")} failed: ${res.stderr.trim().slice(-400)}`);
  return res.stdout;
};

const children = new Set();
let mock;
let mockHits = 0;
const result = { server: server.origin, guest: opts.guest, keyword: opts.keyword, steps: [] };

const cleanUp = () => {
  if (!opts["keep-agent"]) {
    spawnSync("ssh", [...SSH_OPTS, opts.guest, 'cd ~/guard-selfhost-walk 2>/dev/null && [ -f run.pid ] && kill "$(cat run.pid)" 2>/dev/null; rm -f ~/guard-selfhost-walk/run.pid'], { timeout: 20_000 });
    for (const child of children) child.kill("SIGTERM");
    mock?.close();
  }
  spawnSync("ssh", ["-o", `ControlPath=${CONTROL}`, "-O", "exit", opts.guest], { stdio: "ignore", timeout: 10_000 });
  rmSync(sockets, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
};

const curlPrompt = async (text) => {
  const body = JSON.stringify({ messages: [{ content: { parts: [text] } }] });
  const out = await sshAsync(
    [
      "cd ~/guard-selfhost-walk && rm -f reply.h reply.b && curl -sS --max-time 15 -o reply.b -D reply.h -w '%{http_code}' -x http://127.0.0.1:9570 -H 'content-type: application/json' --data-binary @- http://chatgpt.com/backend-api/conversation; echo; tr -d '\\r' < reply.h | grep -i '^x-vibtra-guard:' || true; echo ---; cat reply.b",
    ],
    body,
  );
  const [status, ...rest] = out.split("\n");
  const joined = rest.join("\n");
  const [head, replyBody] = [joined.slice(0, joined.indexOf("---")), joined.slice(joined.indexOf("---") + 4)];
  let json = {};
  try {
    json = JSON.parse(replyBody);
  } catch {
    json = {};
  }
  return { status: Number(status), guard: head.split(":").slice(1).join(":").trim(), body: json };
};

try {
  const master = spawnSync("ssh", ["-M", "-N", "-f", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ControlPersist=yes", "-o", `ControlPath=${CONTROL}`, opts.guest], { stdio: "ignore", timeout: 30_000 });
  if (master.status !== 0) fail(`cannot open an SSH connection to ${opts.guest} with a key`);
  say(`server ${server.origin}; guest ${opts.guest}; the enrol token is read from ${linkFile} and never printed`);
  const guestArch = ssh(["uname -sm"]).trim();
  check(guestArch === "Darwin arm64", `the guest is a Mac on Apple silicon (${guestArch})`);

  say("building the Go agent from this checkout …");
  const bin = path.join(work, "vibtra-guard");
  const built = spawnSync("zsh", [path.join(ROOT, "guard/agent-go/build.sh"), bin], { encoding: "utf8", env: { ...process.env, GOOS: "darwin", GOARCH: "arm64" } });
  if (built.status !== 0) fail(`agent build failed: ${built.stderr.slice(-600)}`);

  mock = http.createServer((req, res) => {
    mockHits += 1;
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end('{"reply":"(stand-in origin) received"}'));
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const mockPort = mock.address().port;

  const forwards = ["-R", `${mockGuestPort}:127.0.0.1:${mockPort}`];
  if (loopback) {
    if (!Number.isInteger(hostPort) || hostPort < 1) fail("--host-port is required");
    forwards.push("-R", `${guestServerPort}:127.0.0.1:${hostPort}`);
  }
  const tunnel = spawn("ssh", ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", ...forwards, opts.guest], { stdio: ["ignore", "ignore", "pipe"] });
  children.add(tunnel);
  let tunnelError = "";
  tunnel.stderr.on("data", (b) => (tunnelError += b));
  const tunnelUp = () => {
    if (tunnel.exitCode !== null || tunnel.signalCode !== null) fail(`the SSH tunnel to the guest closed: ${tunnelError.trim().slice(-300) || "no message"}`);
  };
  const reachable = async (url) => (await sshAsync([`curl -s -m 5 -o /dev/null -w '%{http_code}' ${url} || true`])).trim();
  for (let i = 0; ; i += 1) {
    tunnelUp();
    if ((await reachable(`${server.origin}/healthz`)) === "200" && (await reachable(`http://127.0.0.1:${mockGuestPort}/`)) === "200") break;
    if (i === 39) fail(`the guest cannot reach ${server.origin}/healthz and the stand-in origin`);
    await new Promise((r) => setTimeout(r, 500));
  }
  mockHits = 0;
  check(true, loopback ? `the guest reaches ${server.origin} through an SSH tunnel to 127.0.0.1:${hostPort} on this host` : `the guest reaches ${server.origin}`);

  ssh(['[ ! -f ~/guard-selfhost-walk/run.pid ] || kill "$(cat ~/guard-selfhost-walk/run.pid)" 2>/dev/null; rm -rf ~/guard-selfhost-walk && mkdir -m 700 ~/guard-selfhost-walk']);
  const copied = spawnSync("scp", ["-q", ...SSH_OPTS, bin, `${opts.guest}:guard-selfhost-walk/vibtra-guard`], { encoding: "utf8" });
  if (copied.status !== 0) fail(`copying the agent failed: ${copied.stderr}`);

  const enrolled = ssh(['cd ~/guard-selfhost-walk && IFS= read -r link && ./vibtra-guard enrol --data-dir ./agent --link "$link"'], `${link}\n`);
  check(/Enrolled and synced/.test(enrolled), "the agent enrolled with the link and took its first signed policy");
  const device = JSON.parse(ssh(["cat ~/guard-selfhost-walk/agent/device.json"]));
  result.deviceId = device.deviceId;
  check(typeof device.deviceId === "string" && typeof device.signing?.publicKeyPem === "string", `device ${device.deviceId} pinned the server's signing key`);

  ssh([
    `cd ~/guard-selfhost-walk && nohup ./vibtra-guard run --data-dir ./agent --proxy 127.0.0.1:9570 --local 127.0.0.1:9571 --upstream-map chatgpt.com=http://127.0.0.1:${mockGuestPort} --sync-every 5 > run.log 2>&1 < /dev/null & echo $! > ~/guard-selfhost-walk/run.pid`,
  ]);
  for (let i = 0; ; i += 1) {
    if (/proxy http:\/\/127\.0\.0\.1:9570/.test(ssh(["cat ~/guard-selfhost-walk/run.log"]))) break;
    if (i === 40) fail("the guest agent did not start listening");
    await new Promise((r) => setTimeout(r, 250));
  }
  const status = JSON.parse(ssh(["cd ~/guard-selfhost-walk && ./vibtra-guard status --data-dir ./agent --local 127.0.0.1:9571"]));
  result.bundleVersion = status.bundleVersion;
  check(status.enrolled === true && Number.isInteger(status.bundleVersion), `policy synced: the agent holds signed bundle ${status.bundleVersion}`);

  const nonce = randomBytes(6).toString("hex");
  const prompts = [
    ["normal", `What is a good name for a cat? ${nonce}`],
    ["blocked", `Summarise the ${opts.keyword} budget for me ${nonce}`],
    ["normal", `Thanks, and a dog name? ${nonce}`],
  ];
  const before = mockHits;
  const replies = [];
  for (const [, text] of prompts) {
    tunnelUp();
    replies.push(await curlPrompt(text));
  }
  result.steps = replies.map((r, i) => ({ expected: prompts[i][0], status: r.status, guard: r.guard, code: r.body.code, eventId: r.body.eventId, ruleId: r.body.ruleId }));
  check(replies[0].status === 200, `normal prompt passes (HTTP ${replies[0].status})`);
  check(replies[1].status === 403 && replies[1].body.code === "GUARD_BLOCKED", `prompt with ${opts.keyword} is blocked (HTTP ${replies[1].status} ${replies[1].body.code ?? ""})`);
  check(replies[2].status === 200, `the next normal prompt passes (HTTP ${replies[2].status})`);
  check(mockHits - before === 2, `only the two normal prompts reached the origin (${mockHits - before})`);
  const blockedEventId = replies[1].body.eventId;
  result.blockedEventId = blockedEventId;
  result.ruleId = replies[1].body.ruleId;
  check(/^gev_[A-Za-z0-9_-]+$/.test(blockedEventId ?? ""), `the block names event ${blockedEventId}`);

  ssh(["cd ~/guard-selfhost-walk && ./vibtra-guard sync --data-dir ./agent"]);
  const queued = ssh(["cd ~/guard-selfhost-walk && cat agent/events.jsonl 2>/dev/null || true"]);
  check(!queued.includes(blockedEventId), "the agent uploaded the block event (its queue no longer holds it)");
  const guestFiles = ssh([`grep -rl ${nonce} ~/guard-selfhost-walk/agent 2>/dev/null || true`]).trim();
  check(guestFiles === "", "the agent's profile holds no prompt text");

  if (opts["compose-env"]) {
    const row = compose(["exec", "-T", "postgres", "psql", "-U", "guard", "-d", "guard", "-At", "-F", "|", "-c", `select action, kind, rule_kind, coalesce(rule_name, ''), coalesce(match_type, ''), host from guard_events where event_id = '${blockedEventId}'`]).trim();
    result.storedEvent = row;
    check(row.startsWith("blocked|content|content|"), `Postgres holds the block as metadata: ${row}`);
    const around = compose(["exec", "-T", "postgres", "psql", "-U", "guard", "-d", "guard", "-At", "-F", "|", "-c", `select count(*) filter (where e.occurred_at < b.occurred_at), count(*) filter (where e.occurred_at > b.occurred_at) from guard_events e join guard_events b on b.org_id = e.org_id and b.device_id = e.device_id where b.event_id = '${blockedEventId}' and e.action = 'allowed'`]).trim();
    const [allowedBefore, allowedAfter] = around.split("|").map(Number);
    result.allowedAround = { before: allowedBefore, after: allowedAfter };
    check(allowedBefore >= 1 && allowedAfter >= 1, `Postgres holds allowed traffic before (${allowedBefore}) and after (${allowedAfter}) the block, as Activity shows`);
    const deviceRow = compose(["exec", "-T", "postgres", "psql", "-U", "guard", "-d", "guard", "-At", "-F", "|", "-c", `select status, bundle_version, last_postflight_at is not null from guard_devices where device_id = '${device.deviceId.replace(/[^A-Za-z0-9_-]/g, "")}'`]).trim();
    check(deviceRow.startsWith("active|") && deviceRow.endsWith("|t"), `the device row is active with a recorded sync (${deviceRow})`);
    const dump = compose(["exec", "-T", "postgres", "pg_dump", "-U", "guard", "-d", "guard"]);
    check(!dump.includes(nonce) && !dump.includes(`the ${opts.keyword} budget`), `a full Postgres dump (${dump.length} bytes) holds no prompt text`);
  }

  result.passed = true;
  say(`PASS: device ${device.deviceId} enrolled, bundle ${status.bundleVersion}, normal → blocked (${blockedEventId}) → normal`);
  say(`Now check the dashboard: Devices lists ${device.deviceId}; Activity shows ${blockedEventId} blocked by your rule, with allowed traffic before and after it.`);
} catch (error) {
  result.passed = false;
  result.error = error.message;
  console.error(`[self-host-walk] ${error.message}`);
  process.exitCode = 1;
} finally {
  if (opts.out) writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  if (opts["keep-agent"]) say("--keep-agent: the guest agent and the tunnel stay up until you stop this process");
  else cleanUp();
}
