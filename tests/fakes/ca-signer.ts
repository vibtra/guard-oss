import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type CaSignerMode = "ok" | "refuse-unsigned" | "refuse-requirement" | "no-se" | "keychain-error" | "no-key" | "refuse-ca" | "bad-signature" | "slow" | "down";

export interface CaSigner {
  readonly socket: string;
  readonly env: Readonly<Record<string, string>>;
  setMode(mode: CaSignerMode): Promise<void>;
  requests(op: string): number;
  keys(): Promise<string[]>;
  close(): Promise<void>;
}

const SLOW_MS = 8_000;

const MAX_LINE = 64 * 1024;
const KEY_ID = /^[0-9a-f]{64}$/;
const BASIC_CONSTRAINTS_CA = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x13, 0x01, 0x01, 0xff, 0x04, 0x08, 0x30, 0x06, 0x01, 0x01, 0xff]);

const keyIdOf = (spki: Buffer): string => createHash("sha256").update(spki).digest("hex");
const isCaTbs = (tbs: Buffer): boolean => tbs.includes(BASIC_CONSTRAINTS_CA);
const base64 = (text: string): Buffer | undefined => (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text) ? Buffer.from(text, "base64") : undefined);

export const startCaSigner = async (initial: CaSignerMode = "ok"): Promise<CaSigner> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-ca-signer-"));
  const socket = path.join(dir, "ca-signer.sock");
  const keysDir = await mkdtemp(path.join(dir, "keys-"));
  const counts = new Map<string, number>();
  const connections = new Set<net.Socket>();
  const strangerKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  let mode: CaSignerMode = initial;
  let server: net.Server | undefined;

  const keyFile = (id: string): string => path.join(keysDir, `${id}.pem`);
  const keyIds = async (): Promise<string[]> => (await readdir(keysDir)).map((name) => name.replace(/\.pem$/, ""));
  const loadKey = async (id: string): Promise<KeyObject | undefined> => {
    try {
      return createPrivateKey(await readFile(keyFile(id), "utf8"));
    } catch {
      return undefined;
    }
  };
  const spkiOf = (key: KeyObject): Buffer => createPublicKey(key).export({ type: "spki", format: "der" });
  const signed = (key: KeyObject, tbs: Buffer): string => `ok ${sign("sha256", tbs, key).toString("base64")}`;

  const answer = async (line: string, conn: { createdKey?: string }): Promise<string | undefined> => {
    const parts = line.split(" ");
    const [op = "", id = "", third = "", fourth = ""] = parts;
    counts.set(op, (counts.get(op) ?? 0) + 1);
    const created = conn.createdKey;
    conn.createdKey = undefined;
    const call = `${op}/${parts.length}`;
    if (call === "keys/1") {
      const ids = await keyIds();
      return ids.length === 0 ? "ok" : `ok ${ids.join(",")}`;
    }
    if (call === "create/1") {
      if (mode === "no-se") return "err no-se";
      if (mode === "keychain-error") return "err keychain -34018";
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const spki = spkiOf(privateKey);
      const keyId = keyIdOf(spki);
      await writeFile(keyFile(keyId), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      conn.createdKey = keyId;
      return `ok ${keyId} ${spki.toString("base64")}`;
    }
    if (call === "ca/3") {
      const tbs = base64(third);
      if (!KEY_ID.test(id) || tbs === undefined) return "err bad-request";
      if (created !== id) return "err policy ca-only-after-create";
      if (mode === "refuse-ca") return "err policy spki-mismatch";
      if (!isCaTbs(tbs)) return "err policy not-ca";
      const key = await loadKey(id);
      if (key === undefined) return "err no-key";
      if (!tbs.includes(spkiOf(key))) return "err policy spki-mismatch";
      return signed(key, tbs);
    }
    if (call === "pub/2") {
      if (!KEY_ID.test(id)) return "err bad-request";
      const key = mode === "no-key" ? undefined : await loadKey(id);
      return key === undefined ? "err no-key" : `ok ${spkiOf(key).toString("base64")}`;
    }
    if (call === "sign/4" && third === "m") {
      const tbs = base64(fourth);
      if (!KEY_ID.test(id) || tbs === undefined) return "err bad-request";
      if (isCaTbs(tbs)) return "err policy is-ca";
      const key = mode === "no-key" ? undefined : await loadKey(id);
      if (key === undefined) return "err no-key";
      if (mode === "slow") {
        await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
        return undefined;
      }
      return signed(mode === "bad-signature" ? strangerKey : key, tbs);
    }
    if (call === "prune/1" || call === "prune/2") {
      const keep = id === "" ? [] : id.split(",");
      if (!keep.every((keyId) => KEY_ID.test(keyId))) return "err bad-request";
      const gone = (await keyIds()).filter((keyId) => !keep.includes(keyId));
      await Promise.all(gone.map((keyId) => unlink(keyFile(keyId))));
      return `ok ${gone.length}`;
    }
    return "err bad-request";
  };

  const serve = (conn: net.Socket): void => {
    connections.add(conn);
    conn.once("close", () => connections.delete(conn));
    conn.on("error", () => conn.destroy());
    if (mode === "refuse-unsigned" || mode === "refuse-requirement") {
      conn.end(`err unauthorised ${mode === "refuse-unsigned" ? "unsigned" : "requirement"}\n`);
      return;
    }
    conn.write("ready\n");
    const state: { createdKey?: string } = {};
    let buffered = "";
    let queue = Promise.resolve();
    conn.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      for (let end = buffered.indexOf("\n"); end !== -1 || buffered.length > MAX_LINE; end = buffered.indexOf("\n")) {
        const line = end === -1 ? buffered : buffered.slice(0, end);
        buffered = end === -1 ? "" : buffered.slice(end + 1);
        if (line.length > MAX_LINE || !/^[\x20-\x7e]*$/.test(line)) {
          conn.pause();
          queue = queue.then(() => {
            conn.end("err bad-request\n");
          });
          return;
        }
        queue = queue.then(async () => {
          const reply = await answer(line, state);
          if (reply !== undefined && !conn.destroyed) conn.write(`${reply}\n`);
        });
      }
    });
  };

  const listen = async (): Promise<void> => {
    await rm(socket, { force: true });
    const next = net.createServer(serve);
    next.listen(socket);
    await once(next, "listening");
    server = next;
  };
  const stop = async (): Promise<void> => {
    const current = server;
    server = undefined;
    for (const conn of connections) conn.destroy();
    if (current !== undefined) await new Promise<void>((resolve) => current.close(() => resolve()));
    await rm(socket, { force: true });
  };

  if (initial !== "down") await listen();
  return {
    socket,
    env: { VIBTRA_GUARD_CA_SIGNER_SOCK: socket },
    setMode: async (next) => {
      mode = next;
      if (next === "down") await stop();
      else if (server === undefined) await listen();
      if (next === "refuse-unsigned" || next === "refuse-requirement") for (const conn of connections) conn.destroy();
    },
    requests: (op) => counts.get(op) ?? 0,
    keys: keyIds,
    close: async () => {
      await stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
};
