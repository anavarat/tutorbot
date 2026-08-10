import type { BotsDao } from "../../platform/persistence/bots-dao";
import type { GatewaysDao, GatewayRow } from "../../platform/persistence/gateways-dao";
import type { GatewayLifecycle } from "../../platform/gateway/gateway-lifecycle";
import type { ProvisionGatewayInput } from "./schema";

/** Output view of a gateway registry row (1:1 with the row for now). */
export type GatewayView = GatewayRow;

export type ProvisionGatewayResult = { kind: "ok"; gateway: GatewayView };

export interface ListGatewaysResult {
  count: number;
  gateways: GatewayView[];
}

export type GetOneGatewayResult =
  | { kind: "ok"; gateway: GatewayView }
  | { kind: "not_found"; gatewayId: string };

export type ReapGatewayResult =
  | { kind: "ok"; gatewayId: string; containerStopped: boolean; stopError?: string }
  | { kind: "not_found"; gatewayId: string }
  | { kind: "has_bots"; gatewayId: string; count: number };

/**
 * Gateway lifecycle orchestration. Owns the D1 side-effects and returns tagged
 * results; the controller maps those to HTTP status codes. No HTTP types leak in
 * here. Mirrors BotService.
 *
 * D1 (`gateways`) is the source of truth for "which gateways exist". Container
 * lifecycle is NOT touched here yet — a live container is materialised lazily by
 * the GW Worker (getContainer). Provisioning == upsert the row.
 */
export class GatewayService {
  constructor(
    private readonly gateways: GatewaysDao,
    private readonly bots: BotsDao,
    private readonly lifecycle: GatewayLifecycle,
  ) {}

  /** POST /gateways — allocate/accept an id and upsert the row as active. */
  async provision(input: ProvisionGatewayInput): Promise<ProvisionGatewayResult> {
    // Caller-supplied gatewayId wins; otherwise allocate gw-N from the counter.
    const gatewayId = input.gatewayId?.trim() || (await this.gateways.nextGatewayId());
    const now = Date.now();
    await this.gateways.upsertActive(gatewayId, input.label ?? null, now);
    const row = await this.gateways.get(gatewayId);
    // upsert guarantees the row exists; the get can only be null on a DB fault.
    return { kind: "ok", gateway: row as GatewayView };
  }

  /** GET /gateways — list all registry rows. */
  async list(): Promise<ListGatewaysResult> {
    const rows = await this.gateways.list();
    return { count: rows.length, gateways: rows };
  }

  /** GET /gateways/:id — one row. */
  async getOne(gatewayId: string): Promise<GetOneGatewayResult> {
    const row = await this.gateways.get(gatewayId);
    if (!row) return { kind: "not_found", gatewayId };
    return { kind: "ok", gateway: row };
  }

  /**
   * DELETE /gateways/:id — remove from the roster AND stop its container.
   * Refuses if bots are still pinned to it (would orphan them), unless `force` is
   * set. Two steps, in order:
   *   1. delete the D1 row (control plane) — the PRIMARY effect; nothing new
   *      routes to a gateway that is off the roster.
   *   2. best-effort stop the container (data plane) via the GW Worker — so a
   *      container the GW lazily materialised stops running/billing immediately
   *      instead of lingering until its sleepAfter idle window (5h). A stop
   *      failure is NON-FATAL: the reap already succeeded at step 1.
   */
  async reap(gatewayId: string, force: boolean): Promise<ReapGatewayResult> {
    const row = await this.gateways.get(gatewayId);
    if (!row) return { kind: "not_found", gatewayId };
    if (!force) {
      const count = await this.bots.countOnGateway(gatewayId);
      if (count > 0) return { kind: "has_bots", gatewayId, count };
    }
    await this.gateways.delete(gatewayId);
    const stop = await this.lifecycle.stop(gatewayId);
    return { kind: "ok", gatewayId, containerStopped: stop.ok, stopError: stop.error };
  }
}
