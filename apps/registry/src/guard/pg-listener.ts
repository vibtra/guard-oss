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
  let reconnecting = false;
  let closed = false;

  const destroy = (conn: Connection | undefined): void => {
    if (conn === undefined) return;
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
      application_name: "vibtra-guard-listener",
      stream: () => socket,
    });
    const conn = { client, socket };
    client.on("error", () => lose(conn, "the listen connection failed"));
    client.on("end", () => lose(conn, "the listen connection closed"));
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

  const beat = (): void => {
    heartbeat = setTimeout(() => {
      void ping(heartbeatTimeoutMs).then((ok) => {
        if (closed || reconnecting) return;
        if (ok) beat();
        else lose(current, "a heartbeat notice did not come back");
      });
    }, heartbeatMs);
    heartbeat.unref();
  };

  const lose = (conn: Connection | undefined, reason: string): void => {
    if (closed || reconnecting || conn === undefined || conn !== current) return;
    reconnecting = true;
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
      const conn = await connect().catch(() => undefined);
      if (conn === undefined) continue;
      current = conn;
      if (await ping(selfTestMs)) {
        if (closed || current !== conn) return;
        reconnecting = false;
        sink?.restored();
        beat();
        return;
      }
      current = undefined;
      destroy(conn);
    }
  };

  return {
    start: (target) => {
      sink = target;
      void (async () => {
        let conn: Connection;
        try {
          conn = await connect();
        } catch (error) {
          if (!closed) target.off(`could not open the listen connection (${error instanceof Error ? error.message : "unknown error"})`);
          return;
        }
        if (closed) {
          destroy(conn);
          return;
        }
        current = conn;
        const verified = await ping(selfTestMs);
        if (closed) return;
        if (!verified) {
          current = undefined;
          destroy(conn);
          target.off(`a test notice did not come back within ${selfTestMs / 1000} s`);
          return;
        }
        target.live();
        beat();
      })();
    },
    close: async () => {
      closed = true;
      clearTimeout(heartbeat);
      const conn = current;
      current = undefined;
      destroy(conn);
    },
  };
};
