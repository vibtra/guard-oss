import net from "node:net";
import type { Cleanup } from "../../support/cleanup.ts";

interface PgStatement {
  readonly at: number;
  readonly sql: string;
}

interface PgProxy {
  readonly port: number;
  readonly statements: readonly PgStatement[];
  readonly connections: () => number;
  url(databaseUrl: string): string;
  blackhole(): void;
  refuse(refusing: boolean): void;
}

interface PgProxyOptions {
  readonly dropListen?: boolean;
  readonly cutFirstAfter?: "LISTEN" | ((notice: string) => boolean);
}

const STARTUP_PROTOCOL = 196_608;

const cstring = (buffer: Buffer, from: number): { text: string; next: number } => {
  const end = buffer.indexOf(0, from);
  return end < 0 ? { text: "", next: buffer.length } : { text: buffer.toString("utf8", from, end), next: end + 1 };
};

const message = (type: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};

const listenAnswered = (): Buffer => Buffer.concat([message("C", Buffer.from("LISTEN\0", "utf8")), message("Z", Buffer.from("I", "latin1"))]);

export const startPgProxy = async (cleanup: Cleanup, databaseUrl: string, options: PgProxyOptions = {}): Promise<PgProxy> => {
  const upstream = new URL(databaseUrl);
  const statements: PgStatement[] = [];
  const links = new Set<{ client: net.Socket; server: net.Socket; dark: boolean }>();
  let refusing = false;
  let connections = 0;

  const server = net.createServer((client) => {
    connections += 1;
    if (refusing) {
      client.destroy();
      return;
    }
    const cut = connections === 1 ? options.cutFirstAfter : undefined;
    const link = { client, server: net.connect(Number(upstream.port || "5432"), upstream.hostname), dark: false };
    client.setNoDelay(true);
    link.server.setNoDelay(true);
    links.add(link);
    let pending: Buffer = Buffer.alloc(0);
    let fromServer: Buffer = Buffer.alloc(0);
    let started = false;
    const end = (): void => {
      links.delete(link);
      link.client.destroy();
      link.server.destroy();
    };
    const cutAfter = (last: Buffer): void => {
      link.dark = true;
      link.server.destroy();
      link.client.end(last);
    };
    const fromClient = (chunk: Buffer): void => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      const out: Buffer[] = [];
      for (;;) {
        if (!started) {
          if (pending.length < 8) break;
          const length = pending.readInt32BE(0);
          if (pending.length < length) break;
          const frame = pending.subarray(0, length);
          if (pending.readInt32BE(4) === STARTUP_PROTOCOL) started = true;
          pending = pending.subarray(length);
          out.push(frame);
          continue;
        }
        if (pending.length < 5) break;
        const length = pending.readInt32BE(1) + 1;
        if (pending.length < length) break;
        const frame = pending.subarray(0, length);
        pending = pending.subarray(length);
        const type = String.fromCharCode(frame[0] ?? 0);
        const sql = type === "Q" ? cstring(frame, 5).text : type === "P" ? cstring(frame, cstring(frame, 5).next).text : undefined;
        if (sql !== undefined) statements.push({ at: performance.now(), sql });
        if ((options.dropListen === true || cut === "LISTEN") && type === "Q" && /^\s*LISTEN\b/i.test(sql ?? "")) {
          if (cut === "LISTEN") return cutAfter(listenAnswered());
          link.client.write(listenAnswered());
          continue;
        }
        out.push(frame);
      }
      if (out.length > 0) link.server.write(Buffer.concat(out));
    };
    client.on("data", (chunk: Buffer) => {
      if (!link.dark) fromClient(chunk);
    });
    link.server.on("data", (chunk: Buffer) => {
      if (link.dark) return;
      if (typeof cut !== "function") {
        link.client.write(chunk);
        return;
      }
      fromServer = fromServer.length === 0 ? chunk : Buffer.concat([fromServer, chunk]);
      let at = 0;
      while (at + 5 <= fromServer.length) {
        const next = at + 1 + fromServer.readInt32BE(at + 1);
        if (next > fromServer.length) break;
        const frame = fromServer.subarray(at, next);
        if (String.fromCharCode(frame[0] ?? 0) === "A" && cut(cstring(frame, cstring(frame, 9).next).text)) return cutAfter(fromServer.subarray(0, next));
        at = next;
      }
      link.client.write(fromServer.subarray(0, at));
      fromServer = fromServer.subarray(at);
    });
    client.on("close", end);
    link.server.on("close", () => {
      if (!link.dark) end();
    });
    client.on("error", end);
    link.server.on("error", end);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the Postgres proxy did not listen on a TCP port");
  cleanup.defer(
    () =>
      new Promise<void>((resolve) => {
        for (const link of links) {
          link.client.destroy();
          link.server.destroy();
        }
        server.close(() => resolve());
      }),
  );
  return {
    port: address.port,
    statements,
    connections: () => connections,
    url: (target) => {
      const proxied = new URL(target);
      proxied.hostname = "127.0.0.1";
      proxied.port = String(address.port);
      return proxied.toString();
    },
    blackhole: () => {
      for (const link of links) link.dark = true;
    },
    refuse: (next) => {
      refusing = next;
    },
  };
};
