import { createStageLogger } from "@tutorbot/shared/observability";
import type { WorkerBindings } from "../system/contracts.js";

/**
 * The active gateway roster — the set of gateway (container) names this Worker
 * may route to — is OWNED by FleetManager (its D1 `gateways` table is the
 * control-plane source of truth). This Worker is a thin executor: it fetches the
 * roster over the FLEET_MANAGER service binding and materialises a container per
 * id lazily via getContainer(). There is NO Cloudflare API that lists running
 * containers, so this roster is the only authority on "which gateways exist".
 *
 * The roster changes rarely (provisioning a gateway is an operator action), and
 * the per-request routing check must stay cheap, so we cache it in-isolate with
 * a short TTL. The cache is best-effort:
 *   - fresh hit           -> return cached set (no FM call)
 *   - miss / expired      -> refetch from FM, refresh cache
 *   - refetch FAILS       -> serve the last-known-good set (stale-while-error) so
 *                            a transient FM blip can't black-hole all routing
 *   - cold start + FM down -> empty set (fail-closed): a control-plane outage
 *                            makes NEW routing decisions fail rather than boot
 *                            containers for unvalidated names
 * Failures are never cached, so the next request retries immediately.
 */
interface RosterCache {
  ids: Set<string>;
  expiresAt: number;
}

/** Per-isolate cache. Module scope => survives across requests in one isolate,
 * resets on cold start; never shared across isolates. That is exactly the
 * lifetime we want for a rarely-changing allowlist. */
let cache: RosterCache | null = null;

const TTL_MS = 30_000;

/** Subset of FleetManager's `GET /gateways` response we depend on. */
interface FleetGatewayRow {
  gateway_id: string;
  status: string;
}
interface FleetGatewaysResponse {
  gateways?: FleetGatewayRow[];
}

async function fetchActiveIds(
  fm: NonNullable<WorkerBindings["FLEET_MANAGER"]>,
): Promise<Set<string>> {
  // Host is irrelevant for a service binding (never hits DNS); FleetManager
  // routes on the path. The binding dispatch bypasses Access + CORS.
  const res = await fm.fetch(new Request("https://fleet-manager/gateways", { method: "GET" }));
  if (!res.ok) throw new Error(`FleetManager GET /gateways -> HTTP ${res.status}`);
  const body = (await res.json()) as FleetGatewaysResponse;
  const ids = (body.gateways ?? [])
    .filter((g) => g.status === "active")
    .map((g) => g.gateway_id);
  return new Set(ids);
}

/**
 * The active gateway roster (set of gateway ids), cached in-isolate. Async
 * because a cache miss calls FleetManager over the service binding.
 */
export async function getRoster(env: WorkerBindings): Promise<Set<string>> {
  const now = Date.now();
  if (cache && now < cache.expiresAt) return cache.ids;

  const fm = env.FLEET_MANAGER;
  if (!fm) {
    // No control-plane binding wired: serve stale if we have it, else empty.
    return cache?.ids ?? new Set();
  }

  try {
    const ids = await fetchActiveIds(fm);
    cache = { ids, expiresAt: now + TTL_MS };
    return ids;
  } catch (err) {
    createStageLogger({ context: { svc: "gw-worker" } }).warn(
      "roster.fetch",
      "could not refresh gateway roster from FleetManager; serving last-known-good",
      { error: err instanceof Error ? err.message : String(err), stale: cache !== null },
    );
    return cache?.ids ?? new Set(); // stale-while-error, else fail-closed
  }
}
