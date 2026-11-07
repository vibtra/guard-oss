import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type CaSignerMode = "ok" | "refuse-unsigned" | "refuse-requirement" | "refuse-binding" | "bad-nonce-length" | "bad-nonce-base64" | "bad-ready" | "no-se" | "keychain-error" | "refuse-ca" | "bad-signature" | "slow" | "down";

export interface CaSigner {
  readonly socket: string;
  readonly env: Readonly<Record<string, string>>;
  setMode(mode: CaSignerMode): Promise<void>;
  requests(op: string): number;
  lines(op: string): string[];
  keys(): Promise<string[]>;
  addKey(): Promise<string>;
  removeKey(id: string): Promise<string>;
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
  const received: string[] = [];
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
  const newKey = async (): Promise<{ keyId: string; spki: Buffer }> => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = spkiOf(privateKey);
    const keyId = keyIdOf(spki);
    await writeFile(keyFile(keyId), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    return { keyId, spki };
  };

  const answer = async (line: string, conn: { createdKey?: string }): Promise<string | undefined> => {
    const parts = line.split(" ");
    const [op = "", id = "", third = "", fourth = ""] = parts;
    counts.set(op, (counts.get(op) ?? 0) + 1);
    received.push(line);
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
      const { keyId, spki } = await newKey();
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
      const key = await loadKey(id);
      if (key === undefined) return "err no-key";
      if (mode === "slow") {
        await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
        return undefined;
      }
      return `ok ${spkiOf(key).toString("base64")}`;
    }
    if (call === "sign/4" && third === "m") {
      const tbs = base64(fourth);
      if (!KEY_ID.test(id) || tbs === undefined) return "err bad-request";
      if (isCaTbs(tbs)) return "err policy is-ca";
      const key = await loadKey(id);
      if (key === undefined) return "err no-key";
      if (mode === "keychain-error") return "err keychain -25300";
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
    const nonce = mode === "bad-nonce-length" ? randomBytes(16).toString("base64") : randomBytes(32).toString("base64");
    conn.write(mode === "bad-nonce-base64" ? `nonce ${nonce.slice(1)}!\n` : `nonce ${nonce}\n`);
    let bound = false;
    let busy = false;
    let buffered = "";
    const state: { createdKey?: string } = {};
    const refuse = (reply: string): void => {
      conn.pause();
      conn.end(`${reply}\n`);
    };
    conn.on("data", (chunk: Buffer) => {
      if (busy) {
        conn.destroy();
        return;
      }
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\n");
      if (end === -1) {
        if (buffered.length > MAX_LINE) refuse(bound ? "err bad-request" : "err unauthorised binding");
        return;
      }
      const line = buffered.slice(0, end);
      const pipelined = end + 1 < buffered.length;
      buffered = "";
      const wellFormed = line.length <= MAX_LINE && /^[\x20-\x7e]*$/.test(line);
      if (!bound) {
        counts.set("hello", (counts.get("hello") ?? 0) + 1);
        if (pipelined || !wellFormed || line !== `hello ${nonce}` || mode === "refuse-binding") {
          refuse("err unauthorised binding");
          return;
        }
        bound = true;
        conn.write(mode === "bad-ready" ? "steady\n" : "ready\n");
        return;
      }
      if (pipelined) {
        conn.destroy();
        return;
      }
      if (!wellFormed) {
        refuse("err bad-request");
        return;
      }
      busy = true;
      answer(line, state).then(
        (reply) => {
          busy = false;
          if (reply !== undefined && !conn.destroyed) conn.write(`${reply}\n`);
        },
        () => conn.destroy(),
      );
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
      if (["refuse-unsigned", "refuse-requirement", "refuse-binding", "bad-nonce-length", "bad-nonce-base64", "bad-ready"].includes(next)) for (const conn of connections) conn.destroy();
    },
    requests: (op) => counts.get(op) ?? 0,
    lines: (op) => received.filter((line) => line.split(" ")[0] === op),
    keys: keyIds,
    addKey: async () => (await newKey()).keyId,
    removeKey: async (id) => {
      const pem = await readFile(keyFile(id), "utf8");
      await unlink(keyFile(id));
      return pem;
    },
    close: async () => {
      await stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
};
