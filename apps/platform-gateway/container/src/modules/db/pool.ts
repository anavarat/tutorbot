import pg from "pg";
import type { Pool } from "pg";

/**
 * Lazily-created, process-wide pg.Pool for the message-handling routes (inbound
 * writes, outbox reads).
 *
 * Option B: the DSN is NOT read from process.env anymore. It arrives per-request
 * — the Worker resolves it from the account Secrets Store (cached in-isolate) and
 * forwards it in the DB route's request BODY (body transport; a header would leak
 * into invocation logs); the route handler passes it here. We cache ONE pool
 * keyed on the DSN string: same DSN -> reuse; changed DSN
 * (password rotation) -> retire the old pool and build a new one. So a rotated
 * secret is picked up WITHOUT a redeploy/restart. The DSN is never logged.
 */
let pool: Pool | null = null;
let currentDsn: string | null = null;

export function getPool(connectionString: string): Pool {
  const dsn = connectionString ?? "";
  if (!dsn) {
    // No DSN in the request body (Worker could not resolve it, or a caller hit a
    // DB route directly). Same signal as the old "not set".
    throw new Error("Postgres connection string (DSN) not set");
  }

  if (pool && currentDsn === dsn) {
    return pool;
  }

  if (pool) {
    // DSN changed (rotation): retire the old pool best-effort, don't block the
    // request on teardown.
    const old = pool;
    void old.end().catch(() => {});
  }

  pool = new pg.Pool({
    connectionString: dsn,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  currentDsn = dsn;
  return pool;
}
