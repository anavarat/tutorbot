import type { WorkerBindings } from "../system/contracts.js";

/**
 * Postgres DSN resolution for the gateway Worker.
 *
 * Only the PASSWORD is a secret: it lives in the account Secrets Store (binding
 * env.DB_PASSWORD, async `.get()`). The non-secret parts (user, host,
 * port, db) are plain Worker vars. We assemble the DSN in code and cache the
 * result in a MODULE-GLOBAL variable for TTL_MS to avoid calling `.get()` on
 * every request. This is the Workers analogue of caching a secret in a Lambda
 * global variable:
 *   - the cache lives in THIS isolate's memory (V8 heap), per-isolate;
 *   - it is ephemeral — when the platform recycles the isolate the cache is gone
 *     and the next request re-fetches (self-healing);
 *   - the TTL is code-chosen (10 min here) because the password rotates rarely.
 *
 * The password is URL-encoded (encodeURIComponent) so special characters cannot
 * break the connection string; the STORED secret must therefore be the RAW
 * password (not pre-encoded).
 *
 * On a suspected auth failure (container returns 5xx on a DB route) the caller
 * invalidates the cache so the next request re-fetches — this is how a rotated
 * password is picked up without a redeploy.
 */
const TTL_MS = 10 * 60 * 1000; // 10 minutes; password rotates rarely.

let cached: { value: string; expiresAt: number } | null = null;

export async function getDsn(env: WorkerBindings): Promise<string> {
  const now = Date.now();
  if (cached && now < cached.expiresAt) {
    return cached.value;
  }

  const binding = env.DB_PASSWORD;
  if (!binding) {
    throw new Error("DB_PASSWORD Secrets Store binding is not configured");
  }

  const user = env.DB_USER ?? "";
  const host = env.DB_HOST ?? "";
  const port = env.DB_PORT ?? "5432";
  const db = env.DB_NAME ?? "postgres";
  if (!user || !host) {
    throw new Error("Postgres connection vars not configured (DB_USER / DB_HOST)");
  }

  // Cold isolate: concurrent requests may each call .get() once before the
  // cache is populated. That is acceptable — .get() is cheap and the value is
  // cached immediately after. (No in-flight dedupe to keep this simple.)
  const password = await binding.get();
  if (!password) {
    throw new Error("DB_PASSWORD resolved to an empty value");
  }

  const dsn = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
  cached = { value: dsn, expiresAt: now + TTL_MS };
  return dsn;
}

/** Drop the cached DSN so the next getDsn() re-fetches from the Secrets Store. */
export function invalidateDsn(): void {
  cached = null;
}
