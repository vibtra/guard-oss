import { Buffer } from "node:buffer";
import type pg from "pg";
import { VibtraError } from "../errors.js";

export interface TokenTake {
  ok: boolean;
  count: number;
  firstRefusal: boolean;
  retryAfterSeconds: number;
}

export interface Coordinator {
  readonly kind: "in-process" | "postgres";
  lock<T>(key: string, run: () => Promise<T>): Promise<T>;
  take(key: string, limit: number, windowMs: number): Promise<TokenTake>;
}

export interface Coordinated {
  readonly coordinator?: Coordinator;
}

const LOCK_NAMESPACE = 727274302;

const WINDOWS_TABLE = "registry_coordination_windows";

const LOCK_WAIT_MS = 5_000;

const LOCK_POLL_MIN_MS = 5;
const LOCK_POLL_MAX_MS = 100;

const SWEEP_AFTER_TAKES = 512;

const SWEEP_OLDER_THAN = "1 hour";

const hashKey = (key: string): number => {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(key, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const ensureCoordinationSchema = async (client: {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}): Promise<void> => {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${WINDOWS_TABLE} (
       bucket TEXT PRIMARY KEY,
       window_started_at TIMESTAMPTZ NOT NULL,
       count INTEGER NOT NULL
     )`,
  );
};

export const createPostgresCoordinator = (pool: pg.Pool): Coordinator => {
  let takesSinceSweep = 0;

  return {
    kind: "postgres",

    async lock<T>(key: string, run: () => Promise<T>): Promise<T> {
      const id = hashKey(key);
      const deadline = Date.now() + LOCK_WAIT_MS;
      let wait = LOCK_POLL_MIN_MS;

      for (;;) {
        const client = await pool.connect();
        try {
          const got = await client.query<{ got: boolean }>(`SELECT pg_try_advisory_lock($1, $2) AS got`, [
            LOCK_NAMESPACE,
            id,
          ]);
          if (got.rows[0]?.got === true) {
            try {
              return await run();
            } finally {
              await client
                .query(`SELECT pg_advisory_unlock($1, $2)`, [LOCK_NAMESPACE, id])
                .catch(() => undefined);
            }
          }
        } finally {
          client.release();
        }

        if (Date.now() >= deadline) {
          throw new VibtraError({
            code: "INTERNAL",
            message: "The registry is busy — try that again in a moment",
            detail:
              `waited ${LOCK_WAIT_MS}ms for the coordination lock on ${key} and did not get it. Nothing was ` +
              "read, written or dialled. The lock is held in Postgres (store/coordination.ts), so this means " +
              "another task is holding it longer than a limit check should take.",
          });
        }
        await sleep(wait);
        wait = Math.min(LOCK_POLL_MAX_MS, wait * 2);
      }
    },

    async take(key: string, limit: number, windowMs: number): Promise<TokenTake> {
      const windowSeconds = windowMs / 1000;
      const res = await pool.query<{ count: number; retry_after: number }>(
        `INSERT INTO ${WINDOWS_TABLE} AS w (bucket, window_started_at, count)
              VALUES ($1, now(), 1)
         ON CONFLICT (bucket) DO UPDATE
                SET count = CASE
                      WHEN w.window_started_at + make_interval(secs => $2::double precision) <= now() THEN 1
                      ELSE w.count + 1 END,
                    window_started_at = CASE
                      WHEN w.window_started_at + make_interval(secs => $2::double precision) <= now() THEN now()
                      ELSE w.window_started_at END
           RETURNING count,
                     GREATEST(
                       1,
                       CEIL(EXTRACT(EPOCH FROM (window_started_at + make_interval(secs => $2::double precision) - now())))
                     )::int AS retry_after`,
        [key, windowSeconds],
      );
      const row = res.rows[0];
      if (row === undefined) {
        throw new VibtraError({
          code: "INTERNAL",
          message: "The registry could not charge that against its rate limit",
          detail: `the coordination window for ${key} returned no row; nothing was read, written or dialled`,
        });
      }

      takesSinceSweep += 1;
      if (takesSinceSweep >= SWEEP_AFTER_TAKES) {
        takesSinceSweep = 0;
        void pool
          .query(`DELETE FROM ${WINDOWS_TABLE} WHERE window_started_at < now() - interval '${SWEEP_OLDER_THAN}'`)
          .catch(() => undefined);
      }

      const count = Number(row.count);
      return {
        ok: count <= limit,
        count,
        firstRefusal: count === limit + 1,
        retryAfterSeconds: Math.max(1, Number(row.retry_after)),
      };
    },
  };
};
