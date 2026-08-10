/** Raw row shape of the D1 `gateways` registry table (0004, +probe cols 0007). */
export interface GatewayRow {
  gateway_id: string;
  label: string | null; // optional human label, or null
  status: string; // active | draining | reaped
  created_at: number; // epoch ms
  updated_at: number; // epoch ms
  /** Epoch ms of the last container-liveness probe, or null if never probed (0007). */
  last_probe_at: number | null;
  /** Derived health at the last probe (active|inactive|degraded), null=never probed (0007). */
  last_probe_health: string | null;
}

export type GatewayStatus = "active" | "draining" | "reaped";

/**
 * Probe-derived container health (traffic light #2 "actual"). Independent of
 * `status` (membership): a gateway can be a roster member yet momentarily
 * `degraded`. Derived from a single GET /connections call by the health sweep.
 *   active   — reachable, >=1 live socket.
 *   inactive — reachable, zero live sockets (container up, no channels).
 *   degraded — unreachable / non-2xx.
 */
export type GatewayHealth = "active" | "inactive" | "degraded";

/**
 * A probe older than this is "stale" and no longer trusted to cordon a gateway
 * out of the roster (see listActiveIds guard 2). 15 min = 3 sweep ticks at the
 * 5-min cron, matching the UI's staleness window so roster + light agree.
 */
export const GATEWAY_PROBE_STALE_MS = 15 * 60 * 1000;

/**
 * Data access for the gateway registry. ALL D1 SQL for `gateways` lives here;
 * higher layers work with `GatewayRow` objects and never see SQL. Mirrors
 * BotsDao — gateways are a first-class entity, symmetric with bots.
 */
export class GatewaysDao {
  constructor(private readonly db: D1Database) {}

  async get(gatewayId: string): Promise<GatewayRow | null> {
    return this.db
      .prepare("SELECT * FROM gateways WHERE gateway_id = ?")
      .bind(gatewayId)
      .first<GatewayRow>();
  }

  async list(): Promise<GatewayRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM gateways ORDER BY created_at ASC")
      .all<GatewayRow>();
    return results;
  }

  /**
   * Roster of gateway ids that may ACCEPT NEW PINS — used to validate a bot's
   * gatewayId at provision + reassign time, and (Phase B) the GW routing allowlist.
   *
   * Membership (`status = 'active'`) is the base, PLUS a "cordon" on the health
   * axis: a gateway whose container is confirmed DOWN is pulled from the roster so
   * new bots are not placed onto a dead container (a move/provision onto it would
   * just fail). Two deliberate guards keep the cordon from deadlocking:
   *
   *   1. ONLY an explicit `degraded` cordons. `null` (never probed — e.g. a
   *      brand-new gateway with no bots yet) and `inactive` (up, just no sockets)
   *      STAY in the roster; otherwise a new gateway could never take its first
   *      bot (the container only boots once a bot connects — chicken/egg).
   *   2. ONLY a FRESH degraded cordons. A stale one (a gateway that lost all its
   *      bots is no longer probed, so its last health freezes) fails OPEN — a
   *      membership decision must not ride a stale sample, and a recovered gateway
   *      must not stay cordoned forever. Placement-time exactness, if ever needed,
   *      belongs in an on-demand probe, not this cached roster.
   */
  async listActiveIds(): Promise<string[]> {
    const freshCutoff = Date.now() - GATEWAY_PROBE_STALE_MS;
    const { results } = await this.db
      .prepare(
        `SELECT gateway_id FROM gateways
          WHERE status = 'active'
            AND NOT (last_probe_health = 'degraded'
                     AND last_probe_at IS NOT NULL
                     AND last_probe_at >= ?)
          ORDER BY created_at ASC`,
      )
      .bind(freshCutoff)
      .all<{ gateway_id: string }>();
    return results.map((r) => r.gateway_id);
  }

  /**
   * Upsert a gateway as 'active'; created_at is preserved on conflict, label is
   * overwritten. Re-provisioning an existing id just refreshes its label + marks
   * it active again (symmetric with BotsDao.upsertProvisioning).
   */
  async upsertActive(gatewayId: string, label: string | null, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO gateways (gateway_id, label, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)
         ON CONFLICT(gateway_id) DO UPDATE SET
           label      = excluded.label,
           status     = 'active',
           updated_at = excluded.updated_at`,
      )
      .bind(gatewayId, label, now, now)
      .run();
  }

  async setStatus(gatewayId: string, status: GatewayStatus, now: number = Date.now()): Promise<void> {
    await this.db
      .prepare("UPDATE gateways SET status = ?, updated_at = ? WHERE gateway_id = ?")
      .bind(status, now, gatewayId)
      .run();
  }

  /**
   * Record the derived health of a container-liveness probe (0007). Called by the
   * connection health sweep for each gateway it probes. Deliberately does NOT touch
   * `status` (that stays control-plane MEMBERSHIP, read by listActiveIds for the
   * provisioning roster) or `updated_at` (probe != a lifecycle edit): membership and
   * health are independent axes, same split as bots' reassign columns. Idempotent per
   * tick; a no-op if the row was reaped between sweeps.
   */
  async recordProbe(gatewayId: string, health: GatewayHealth, now: number = Date.now()): Promise<void> {
    await this.db
      .prepare("UPDATE gateways SET last_probe_at = ?, last_probe_health = ? WHERE gateway_id = ?")
      .bind(now, health, gatewayId)
      .run();
  }

  async delete(gatewayId: string): Promise<void> {
    await this.db.prepare("DELETE FROM gateways WHERE gateway_id = ?").bind(gatewayId).run();
  }

  /**
   * Allocate the next auto-generated gateway id (gw-N) from a monotonic D1 counter
   * via one atomic UPSERT ... RETURNING. Seeded to 2 in 0004 so the first
   * allocation is gw-3 (gw-1/gw-2 are seeded rows). Used when the caller does not
   * supply a gatewayId.
   */
  async nextGatewayId(): Promise<string> {
    const row = await this.db
      .prepare(
        `INSERT INTO counters (name, value) VALUES ('gateway', 1)
         ON CONFLICT(name) DO UPDATE SET value = value + 1
         RETURNING value`,
      )
      .first<{ value: number }>();
    return `gw-${row?.value ?? 1}`;
  }
}
