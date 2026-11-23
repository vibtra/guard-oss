import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";
import { VibtraError } from "../errors.js";
import { advisoryLockOf, createInProcessCoordinator } from "./coordination.js";

declare const withOrgLock: unique symbol;

export type OrgLockedTx = { readonly [withOrgLock]: true } & { readonly orgId: string };

export interface OrgLocks {
  withOrgLock<T>(orgId: string, run: (tx: OrgLockedTx) => Promise<T>): Promise<T>;
}

const orgLockKey = (orgId: string): string => `claim:join:${orgId}`;

const clients = new WeakMap<OrgLockedTx, pg.PoolClient>();
const held = new WeakSet<OrgLockedTx>();
const lockedHere = new AsyncLocalStorage<readonly OrgLockedTx[]>();

const refuseNested = (orgId: string): void => {
  if (!lockedHere.getStore()?.some((tx) => tx.orgId === orgId && held.has(tx))) return;
  throw new VibtraError({
    code: "INTERNAL",
    message: "Something went wrong",
    detail: `withOrgLock(${orgId}) was called inside a withOrgLock that already holds ${orgId}, so it would wait on itself forever; nothing was written. Pass the outer tx down instead of taking the lock again.`,
  });
};

const runLocked = async <T>(orgId: string, client: pg.PoolClient | undefined, run: (tx: OrgLockedTx) => Promise<T>): Promise<T> => {
  const tx = { orgId } as OrgLockedTx;
  if (client !== undefined) clients.set(tx, client);
  held.add(tx);
  try {
    return await lockedHere.run([...(lockedHere.getStore() ?? []), tx], () => run(tx));
  } finally {
    held.delete(tx);
  }
};

export const createPostgresOrgLocks = (pool: pg.Pool): OrgLocks => ({
  async withOrgLock(orgId, run) {
    refuseNested(orgId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [...advisoryLockOf(orgLockKey(orgId))]);
      const result = await runLocked(orgId, client, run);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
});

export const createInProcessOrgLocks = (): OrgLocks => {
  const locks = createInProcessCoordinator(() => Date.now());
  return {
    async withOrgLock(orgId, run) {
      refuseNested(orgId);
      return locks.lock(orgLockKey(orgId), () => runLocked(orgId, undefined, run));
    },
  };
};

export const orgOf = (tx: OrgLockedTx): string => {
  if (!held.has(tx)) {
    throw new VibtraError({
      code: "INTERNAL",
      message: "Something went wrong",
      detail: `a store got an org lock for ${tx.orgId} that withOrgLock did not make or has already released; nothing was written. Use only the tx withOrgLock passes to its function, and only before that function returns.`,
    });
  }
  return tx.orgId;
};

export const sqlOf = (tx: OrgLockedTx): pg.PoolClient => {
  const orgId = orgOf(tx);
  const client = clients.get(tx);
  if (client === undefined) {
    throw new VibtraError({
      code: "INTERNAL",
      message: "Something went wrong",
      detail: `a Postgres store got an org lock for ${orgId} that the in-process locks made; nothing was written. Wire createPostgresOrgLocks with Postgres stores.`,
    });
  }
  return client;
};
