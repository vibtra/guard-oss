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

const runLocked = async <T>(orgId: string, client: pg.PoolClient | undefined, run: (tx: OrgLockedTx) => Promise<T>): Promise<T> => {
  const tx = { orgId } as OrgLockedTx;
  if (client !== undefined) clients.set(tx, client);
  held.add(tx);
  try {
    return await run(tx);
  } finally {
    held.delete(tx);
  }
};

export const createPostgresOrgLocks = (pool: pg.Pool): OrgLocks => ({
  async withOrgLock(orgId, run) {
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
  return { withOrgLock: (orgId, run) => locks.lock(orgLockKey(orgId), () => runLocked(orgId, undefined, run)) };
};

export const sqlOf = (tx: OrgLockedTx): pg.PoolClient => {
  const client = clients.get(tx);
  if (client === undefined || !held.has(tx)) {
    throw new VibtraError({
      code: "INTERNAL",
      message: "Something went wrong",
      detail: `a Postgres store got an org lock for ${tx.orgId} that ${client === undefined ? "the in-process locks made" : "was already released"}; nothing was written. Wire createPostgresOrgLocks with Postgres stores, and use a tx only inside its withOrgLock.`,
    });
  }
  return client;
};
