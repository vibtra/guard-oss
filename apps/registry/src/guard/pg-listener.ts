// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import net from "node:net";
import pg from "pg";
import { GUARD_POLICY_CHANNEL, parseNoticePayload, pingPayload, type GuardNoticeFeed, type GuardNoticeSink } from "./policy-notices.js";

interface PgNoticeFeedOptions {
  connectionString: string;
  notify: (payload: string) => Promise<unknown>;
  selfTestMs?: number;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
}

const RECONNECT_MAX_MS = 30_000;

interface Connection {
  readonly client: pg.Client;
  readonly socket: net.Socket;
  dropped: string | undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());

export const createPgNoticeFeed = (options: PgNoticeFeedOptions): GuardNoticeFeed => {
  const selfTestMs = options.selfTestMs ?? 3_000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000;
  const pings = new Map<string, () => void>();
  let sink: GuardNoticeSink | undefined;
  let current: Connection | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;

  const destroy = (conn: Connection): void => {
    conn.client.removeAllListeners("notification");
    conn.client.end().catch(() => undefined);
    conn.socket.destroy();
  };

  const connect = async (): Promise<Connection> => {
    const socket = new net.Socket();
    const client = new pg.Client({
      connectionString: options.connectionString,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      fallback_application_name: "vibtra-guard-listener",
      stream: () => socket,
    });
    const conn: Connection = { client, socket, dropped: undefined };
    const drop = (reason: string): void => {
      conn.dropped ??= reason;
      if (conn === current) lose(conn, reason);
    };
    client.on("error", () => drop("the listen connection failed"));
    client.on("end", () => drop("the listen connection closed"));
    client.on("notification", (message) => {
      if (message.channel !== GUARD_POLICY_CHANNEL) return;
      const notice = parseNoticePayload(message.payload ?? "");
      if (notice === undefined) return;
      if ("ping" in notice) pings.get(notice.ping)?.();
      else sink?.notice(notice);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${GUARD_POLICY_CHANNEL}`);
      return conn;
    } catch (error) {
      destroy(conn);
      throw error;
    }
  };

  const ping = async (timeoutMs: number): Promise<boolean> => {
    const nonce = randomUUID();
    let timer: NodeJS.Timeout | undefined;
    const arrived = new Promise<boolean>((resolve) => {
      pings.set(nonce, () => resolve(true));
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      await options.notify(pingPayload(nonce));
      return await arrived;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      pings.delete(nonce);
    }
  };

  const establish = async (): Promise<Connection | string> => {
    let conn: Connection;
    try {
      conn = await connect();
    } catch (error) {
      return `could not open the listen connection (${error instanceof Error ? error.message : "unknown error"})`;
    }
    if (!closed && (await ping(selfTestMs))) return conn;
    destroy(conn);
    return conn.dropped ?? `a test notice did not come back within ${selfTestMs / 1000} s`;
  };

  const beat = (conn: Connection): void => {
    heartbeat = setTimeout(() => {
      void ping(heartbeatTimeoutMs).then((ok) => {
        if (conn !== current) return;
        if (ok) beat(conn);
        else lose(conn, "a heartbeat notice did not come back");
      });
    }, heartbeatMs);
    heartbeat.unref();
  };

  const adopt = (conn: Connection, announce: () => void): void => {
    if (closed) return destroy(conn);
    current = conn;
    announce();
    beat(conn);
    if (conn.dropped !== undefined) lose(conn, conn.dropped);
  };

  const lose = (conn: Connection, reason: string): void => {
    if (closed || conn !== current) return;
    clearTimeout(heartbeat);
    current = undefined;
    destroy(conn);
    sink?.lost(reason);
    void reconnect();
  };

  const reconnect = async (): Promise<void> => {
    for (let delay = 1_000; ; delay = Math.min(RECONNECT_MAX_MS, delay * 2)) {
      await sleep(delay / 2 + Math.random() * (delay / 2));
      if (closed) return;
      const conn = await establish();
      if (typeof conn !== "string") return adopt(conn, () => sink?.restored());
    }
  };

  return {
    start: (target) => {
      sink = target;
      void establish().then((conn) => {
        if (typeof conn !== "string") adopt(conn, () => target.live());
        else if (!closed) target.off(conn);
      });
    },
    close: async () => {
      closed = true;
      clearTimeout(heartbeat);
      const conn = current;
      current = undefined;
      if (conn !== undefined) destroy(conn);
    },
  };
};
