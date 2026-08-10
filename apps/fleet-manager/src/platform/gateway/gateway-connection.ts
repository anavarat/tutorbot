import type { FleetEnv } from "../../types";

/**
 * Identity of the connected Telegram account, echoed back by the container after
 * getMe(). `id` is the permanent Telegram user-id (stringified — the wire value
 * is a big-integer). Never contains the session credential.
 */
export interface ConnectionIdentity {
  id: string;
  username: string | null;
  phone: string | null;
}

/** Everything the gateway needs to open one bot's MTProto socket. */
export interface GatewayConnectionInput {
  gatewayId: string; // routes the request to the right container
  botId: string; // == botAccountId inside the container
  apiId: number; // per-bot MTProto app creds (anti-ban)
  apiHash: string;
  sessionCredential: string; // StringSession — FULL ACCOUNT ACCESS (secret)
}

export type GatewayConnectionResult =
  | { ok: true; identity: ConnectionIdentity }
  | { ok: false; error: string };

/** Identify a bot's live connection for teardown (reassignment DETACH). */
export interface GatewayDisconnectInput {
  gatewayId: string; // routes the request to the container currently holding the socket
  botId: string;
}

export type GatewayDisconnectResult = { ok: true } | { ok: false; error: string };

/** The live connection set a gateway container reports (health reconcile):
 *  the botIds it currently holds an open MTProto socket for. */
export type GatewayStatusResult =
  | { ok: true; connected: string[] }
  | { ok: false; error: string };

export interface GatewayConnections {
  connect(input: GatewayConnectionInput): Promise<GatewayConnectionResult>;
  /**
   * Tear a bot's live socket down on `gatewayId` and drop the gateway DO's stored
   * credential copy (reassignment DETACH). Idempotent: a bot with no
   * live socket resolves ok (the container reports `disconnected: false`).
   */
  disconnect(input: GatewayDisconnectInput): Promise<GatewayDisconnectResult>;
  /**
   * Probe which bots have a LIVE socket on `gatewayId` right now. Used
   * by the health-reconcile sweep to find running bots whose socket silently died.
   * ok:false when the gateway is unreachable (the sweep then SKIPS it, rather than
   * mistaking "can't probe" for "all sockets dead").
   */
  status(gatewayId: string): Promise<GatewayStatusResult>;
}

/** Pull a human message out of the GW's two error shapes: a bare string, or the
 *  worker's `{ error: { code, message } }` envelope. */
function extractError(body: { error?: unknown } | null): string | null {
  if (!body || body.error == null) return null;
  if (typeof body.error === "string") return body.error;
  if (typeof body.error === "object" && "message" in (body.error as object)) {
    const m = (body.error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return null;
}

/**
 * Binds a bot's pre-minted StringSession to a live Telegram client INSIDE its
 * gateway container, via the GW Worker's POST /connection/connect over the INTERNAL
 * `GATEWAY` service binding.
 *
 * WHY the binding (not GATEWAY_BASE_URL): same rationale as GatewayDirectory /
 * GatewayLifecycle — a same-zone Worker->Worker fetch to an Access-gated
 * *.workers.dev host is rejected by the edge (error 1042) before Access runs, so
 * the internal binding is REQUIRED on the same account. No binding => hard error
 * (unlike discovery, a connection connect cannot be silently skipped).
 *
 * WHY FM -> GW directly (not via bot-fleet): the session credential is consumed
 * ONLY by the gateway container (where the MTProto socket lives); bot-fleet never
 * needs it, so the secret must not ride the runtime.start() path through the
 * BotFleetDO. This client keeps the session on the FM -> GW leg only.
 *
 * The GW Worker resolves + injects the Postgres DSN itself, so this body carries only
 * the credential fields. `phone` is deliberately omitted (the container doesn't
 * need it — the StringSession already encodes the account). ⚠ sessionCredential
 * + apiHash are secrets: they ride the JSON body (never a header/URL that
 * invocation logs capture) and are never logged.
 */
export class HttpGatewayConnections implements GatewayConnections {
  constructor(private readonly gateway: FleetEnv["GATEWAY"]) {}

  async connect(input: GatewayConnectionInput): Promise<GatewayConnectionResult> {
    const gw = this.gateway;
    if (!gw) return { ok: false, error: "GATEWAY binding not configured" };
    try {
      // Host is irrelevant for a service binding — GW's router matches on path.
      const res = await gw.fetch(
        new Request("https://gateway.internal/connection/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            gatewayId: input.gatewayId,
            botId: input.botId,
            sessionCredential: input.sessionCredential,
            apiId: input.apiId,
            apiHash: input.apiHash,
          }),
        }),
      );
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; identity?: Partial<ConnectionIdentity>; error?: unknown }
        | null;
      if (!res.ok || !body?.ok) {
        return { ok: false, error: extractError(body) ?? `GW /connection/connect -> HTTP ${res.status}` };
      }
      return {
        ok: true,
        identity: {
          id: typeof body.identity?.id === "string" ? body.identity.id : "",
          username: typeof body.identity?.username === "string" ? body.identity.username : null,
          phone: typeof body.identity?.phone === "string" ? body.identity.phone : null,
        },
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async disconnect(input: GatewayDisconnectInput): Promise<GatewayDisconnectResult> {
    const gw = this.gateway;
    if (!gw) return { ok: false, error: "GATEWAY binding not configured" };
    try {
      const res = await gw.fetch(
        new Request("https://gateway.internal/connection/disconnect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gatewayId: input.gatewayId, botId: input.botId }),
        }),
      );
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: unknown } | null;
      if (!res.ok || !body?.ok) {
        return { ok: false, error: extractError(body) ?? `GW /connection/disconnect -> HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async status(gatewayId: string): Promise<GatewayStatusResult> {
    const gw = this.gateway;
    if (!gw) return { ok: false, error: "GATEWAY binding not configured" };
    try {
      // GET, no body/secret. GW route: /gateways/:id/connections -> container /connections.
      const res = await gw.fetch(
        new Request(`https://gateway.internal/gateways/${encodeURIComponent(gatewayId)}/connections`, {
          method: "GET",
        }),
      );
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; connected?: unknown; error?: unknown }
        | null;
      if (!res.ok || !body?.ok) {
        return { ok: false, error: extractError(body) ?? `GW GET /connections -> HTTP ${res.status}` };
      }
      const connected = Array.isArray(body.connected)
        ? body.connected.filter((x): x is string => typeof x === "string")
        : [];
      return { ok: true, connected };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
