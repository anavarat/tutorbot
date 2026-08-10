import type { FleetEnv } from "../../types";

/**
 * Controls a gateway's CONTAINER lifecycle (data plane) — as opposed to
 * GatewayDirectory, which reads the D1 ROSTER (control plane). These are two
 * different planes: removing a gateway from the roster (D1) does NOT stop the
 * Cloudflare Container the GW Worker lazily materialised via getContainer(); that
 * container keeps running (and billing, when active) until its sleepAfter idle
 * window (5h). So reap ALSO asks the GW Worker to stop the container.
 */
export interface GatewayLifecycle {
  /**
   * Best-effort stop the gateway's container instance. NON-FATAL for reap: the
   * roster row is already gone, so a stop failure only means the container
   * lingers until sleepAfter rather than stopping immediately.
   */
  stop(gatewayId: string): Promise<{ ok: boolean; error?: string }>;
}

/**
 * Stops a gateway container via the GW Worker's POST /gateways/:id/stop, over the
 * INTERNAL GATEWAY service binding (bypasses Cloudflare Access + the public edge;
 * a same-zone public *.workers.dev fetch would be rejected with error 1042).
 * Mirrors HttpGatewayDirectory's transport choice. No binding => "not configured"
 * no-op (reap still succeeds; the container just lingers until sleepAfter).
 */
export class HttpGatewayLifecycle implements GatewayLifecycle {
  constructor(private readonly gateway: FleetEnv["GATEWAY"]) {}

  async stop(gatewayId: string): Promise<{ ok: boolean; error?: string }> {
    const gw = this.gateway;
    if (!gw) return { ok: false, error: "GATEWAY binding not configured" };
    try {
      // Host is irrelevant for a service binding — GW's router matches on path.
      const res = await gw.fetch(
        new Request(`https://gateway.internal/gateways/${encodeURIComponent(gatewayId)}/stop`, {
          method: "POST",
        }),
      );
      if (!res.ok) return { ok: false, error: `GW stop -> HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
