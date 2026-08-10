import { describe, expect, it } from "vitest";

import { GatewayService } from "./service";
import type { BotsDao } from "../../platform/persistence/bots-dao";
import type { GatewaysDao, GatewayRow } from "../../platform/persistence/gateways-dao";
import type { GatewayLifecycle } from "../../platform/gateway/gateway-lifecycle";

// ---- fakes ---------------------------------------------------------------

class FakeGatewaysDao {
  rows = new Map<string, GatewayRow>();
  counter = 2; // seeded to 2 in 0004 -> first auto id is gw-3

  seed(row: Partial<GatewayRow> & { gateway_id: string }): this {
    this.rows.set(row.gateway_id, {
      gateway_id: row.gateway_id,
      label: row.label ?? null,
      status: row.status ?? "active",
      created_at: row.created_at ?? 1000,
      updated_at: row.updated_at ?? 1000,
      last_probe_at: row.last_probe_at ?? null,
      last_probe_health: row.last_probe_health ?? null,
    });
    return this;
  }

  async nextGatewayId(): Promise<string> {
    return `gw-${++this.counter}`;
  }
  async get(gatewayId: string): Promise<GatewayRow | null> {
    return this.rows.get(gatewayId) ?? null;
  }
  async list(): Promise<GatewayRow[]> {
    return [...this.rows.values()];
  }
  async upsertActive(gatewayId: string, label: string | null, now: number): Promise<void> {
    const existing = this.rows.get(gatewayId);
    this.rows.set(gatewayId, {
      gateway_id: gatewayId,
      label,
      status: "active",
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_probe_at: existing?.last_probe_at ?? null,
      last_probe_health: existing?.last_probe_health ?? null,
    });
  }
  async delete(gatewayId: string): Promise<void> {
    this.rows.delete(gatewayId);
  }
}

/** Minimal BotsDao — GatewayService only calls countOnGateway. */
class FakeBotsDao {
  counts: Record<string, number> = {};
  async countOnGateway(gatewayId: string): Promise<number> {
    return this.counts[gatewayId] ?? 0;
  }
}

class FakeLifecycle implements GatewayLifecycle {
  stopCalls: string[] = [];
  result: { ok: boolean; error?: string } = { ok: true };
  async stop(gatewayId: string): Promise<{ ok: boolean; error?: string }> {
    this.stopCalls.push(gatewayId);
    return this.result;
  }
}

function make() {
  const gateways = new FakeGatewaysDao();
  const bots = new FakeBotsDao();
  const lifecycle = new FakeLifecycle();
  const svc = new GatewayService(
    gateways as unknown as GatewaysDao,
    bots as unknown as BotsDao,
    lifecycle,
  );
  return { gateways, bots, lifecycle, svc };
}

// ---- provision -----------------------------------------------------------

describe("GatewayService.provision", () => {
  it("auto-allocates gw-N and stores it active", async () => {
    const { svc, gateways } = make();
    const res = await svc.provision({});
    expect(res.gateway.gateway_id).toBe("gw-3");
    expect(res.gateway.status).toBe("active");
    expect(gateways.rows.has("gw-3")).toBe(true);
  });

  it("accepts an explicit id + label", async () => {
    const { svc } = make();
    const res = await svc.provision({ gatewayId: "gw-eu-1", label: "EU west" });
    expect(res.gateway.gateway_id).toBe("gw-eu-1");
    expect(res.gateway.label).toBe("EU west");
  });
});

// ---- reap ----------------------------------------------------------------

describe("GatewayService.reap", () => {
  it("returns not_found for an unknown gateway", async () => {
    const { svc } = make();
    const res = await svc.reap("gw-x", false);
    expect(res).toEqual({ kind: "not_found", gatewayId: "gw-x" });
  });

  it("refuses to reap a gateway that still has bots (no force)", async () => {
    const { svc, gateways, bots, lifecycle } = make();
    gateways.seed({ gateway_id: "gw-1" });
    bots.counts["gw-1"] = 3;
    const res = await svc.reap("gw-1", false);
    expect(res).toEqual({ kind: "has_bots", gatewayId: "gw-1", count: 3 });
    expect(gateways.rows.has("gw-1")).toBe(true); // NOT deleted
    expect(lifecycle.stopCalls).toHaveLength(0);
  });

  it("force-reaps even with bots attached", async () => {
    const { svc, gateways, bots, lifecycle } = make();
    gateways.seed({ gateway_id: "gw-1" });
    bots.counts["gw-1"] = 3;
    const res = await svc.reap("gw-1", true);
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.containerStopped).toBe(true);
    expect(gateways.rows.has("gw-1")).toBe(false);
    expect(lifecycle.stopCalls).toEqual(["gw-1"]);
  });

  it("reaps cleanly when no bots are attached", async () => {
    const { svc, gateways, lifecycle } = make();
    gateways.seed({ gateway_id: "gw-1" });
    const res = await svc.reap("gw-1", false);
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.containerStopped).toBe(true);
    expect(gateways.rows.has("gw-1")).toBe(false);
    expect(lifecycle.stopCalls).toEqual(["gw-1"]);
  });

  it("treats a container-stop failure as non-fatal (row still removed)", async () => {
    const { svc, gateways, lifecycle } = make();
    gateways.seed({ gateway_id: "gw-1" });
    lifecycle.result = { ok: false, error: "GW stop -> HTTP 500" };
    const res = await svc.reap("gw-1", false);
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.containerStopped).toBe(false);
    expect(res.stopError).toBe("GW stop -> HTTP 500");
    expect(gateways.rows.has("gw-1")).toBe(false);
  });
});
