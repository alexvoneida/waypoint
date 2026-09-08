import { Pool, type PoolClient } from "pg";

// Module-scoped so Next's dev server hot reload does not open a new pool on
// every edit. The pool is cached on globalThis, which survives module
// re-evaluation in dev but not a process restart, exactly like the pattern
// used for database clients in other Next.js apps.
const globalForPool = globalThis as unknown as { waypointPool?: Pool };

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({ connectionString });
}

export function getPool(): Pool {
  if (process.env.NODE_ENV === "production") {
    return createPool();
  }
  if (!globalForPool.waypointPool) {
    globalForPool.waypointPool = createPool();
  }
  return globalForPool.waypointPool;
}

/**
 * Runs `run` in one transaction with `app.user_id` set for every row-level
 * security policy to read. `userId` of `null` means an unauthenticated
 * reader and still calls `set_config`, with an empty string, so a borrowed
 * connection can never keep a previous request's identity by omission.
 *
 * The third argument to `set_config` (`is_local`) must be `true`: that scopes
 * the setting to the current transaction, so it cannot leak to the next
 * borrower of this pooled connection once the transaction ends.
 */
export async function withUser<T>(
  userId: string | null,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config($1, $2, true)", ["app.user_id", userId ?? ""]);
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function readPublic<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  return withUser(null, run);
}
