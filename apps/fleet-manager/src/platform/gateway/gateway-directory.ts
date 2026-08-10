import type { FleetEnv } from "../../types";
import type { GatewaysDao } from "../persistence/gateways-dao";

/**
 * Result of reading the gateway roster from the GW Worker.
 *  - ok           : the GW returned its GATEWAY_IDS roster.
 *  - unconfigured : neither the GATEWAY service binding nor GATEWAY_BASE_URL is
 *                   configured (discovery disabled).
 *  - error        : the GW was unreachable / returned non-2xx.
 * Both unconfigured and error are NON-FATAL for provisioning — the caller skips
 * validation so a momentarily-unreachable GW never blocks bot creation.
 */
export type GatewayListResult =
  | { status: "ok"; gateways: string[] }
  | { status: "unconfigured" }
  | { status: "error"; err: string };

export interface GatewayDirectory {
  describe(): Promise<GatewayListResult>;
}

/**
 * D1-backed gateway directory: reads the ACTIVE gateway roster from FM's OWN
 * `gateways` table (the source of truth since migration 0004). This replaces
 * HttpGatewayDirectory for provision-time validation — FM no longer asks the GW
 * Worker "is this a real gateway?"; it owns that answer. Always returns "ok"
 * (D1 is local + authoritative), so an unknown gatewayId is now a hard 400 at
 * provision time instead of being silently skipped.
 */
export class D1GatewayDirectory implements GatewayDirectory {
  constructor(private readonly gateways: GatewaysDao) {}

  async describe(): Promise<GatewayListResult> {
    const gateways = await this.gateways.listActiveIds();
    return { status: "ok", gateways };
  }
}

/**
 * Reads the gateway roster from the GW Worker's GET /gateways. That roster is
 * the GW's operator-controlled GATEWAY_IDS list (there is no Cloudflare API that
 * lists running containers). Used to expose discovery to the operator/UI and to
 * validate a bot's gatewayId at provision time.
 *
 * Transport, in priority order (mirrors bot-fleet's deliverReplyToGateway,
 * apps/bot-fleet/src/platform/gateway/gateway-client.ts):
 *  1. env.GATEWAY service binding (PREFERRED). A Worker->Worker call reaches GW
 *     directly, bypassing Cloudflare Access + the public edge — REQUIRED on the
 *     same account, because a same-zone Worker fetch to an Access-gated
 *     *.workers.dev host is rejected by the edge (error 1042) before Access even
 *     runs, so the token never matters.
 *  2. env.GATEWAY_BASE_URL + optional CF-Access service-token headers (FALLBACK,
 *     for a cross-zone / cross-account setup where the fetch really egresses).
 * Neither configured => unconfigured (discovery disabled; caller skips validation).
 */
export class HttpGatewayDirectory implements GatewayDirectory {
  constructor(private readonly env: FleetEnv) {}

  async describe(): Promise<GatewayListResult> {
    // 1. PREFERRED: internal service binding (no Access, no public edge). The
    //    host is irrelevant for a binding — GW's router matches on path.
    const gw = this.env.GATEWAY;
    if (gw) {
      return this.readRoster(() => gw.fetch("https://gateway.internal/gateways"));
    }

    // 2. FALLBACK: public base URL + optional Access service-token headers.
    const base = (this.env.GATEWAY_BASE_URL ?? "").replace(/\/+$/, "");
    if (!base) {
      return { status: "unconfigured" };
    }
    const headers: Record<string, string> = {};
    if (this.env.GW_ACCESS_CLIENT_ID && this.env.GW_ACCESS_CLIENT_SECRET) {
      headers["CF-Access-Client-Id"] = this.env.GW_ACCESS_CLIENT_ID;
      headers["CF-Access-Client-Secret"] = this.env.GW_ACCESS_CLIENT_SECRET;
    }
    return this.readRoster(() => fetch(`${base}/gateways`, { headers }));
  }

  /** Shared response handling for both transports. */
  private async readRoster(doFetch: () => Promise<Response>): Promise<GatewayListResult> {
    try {
      const res = await doFetch();
      if (!res.ok) {
        return { status: "error", err: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as { gateways?: unknown };
      const gateways = Array.isArray(body.gateways)
        ? body.gateways.filter((value): value is string => typeof value === "string")
        : [];
      return { status: "ok", gateways };
    } catch (e) {
      return { status: "error", err: e instanceof Error ? e.message : String(e) };
    }
  }
}
