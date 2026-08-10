import type { CorrelationContext, StageLogger } from "@tutorbot/shared/observability";

/**
 * Fleet-Manager bindings. This Worker is a STATELESS control plane:
 *   1. keeps a D1 registry of which bots exist, and
 *   2. drives each bot's lifecycle by calling bot-fleet's HTTP control routes
 *      (POST /bots/:id/start etc.) over the BOT_FLEET service binding.
 *
 * There is NO cross-script Durable Object namespace here anymore: bot-fleet OWNS
 * the BotFleetDO class and resolves the per-bot DO internally, so fleet-manager
 * reaches it purely over HTTP. The persona picker reads Postgres directly through
 * its own HYPERDRIVE binding (no longer proxied via bot-fleet).
 */
export interface FleetEnv {
  /** D1 registry of provisioned bots (source of truth for "which bots exist"). */
  DB: D1Database;

  /**
   * PREFERRED gateway-discovery transport: internal service binding to the GW
   * Worker (script "platform-gateway"). A Worker->Worker binding call
   * reaches GW directly, bypassing Cloudflare Access + the public edge — REQUIRED
   * on the same Cloudflare account, because a Worker `fetch()` to another Worker
   * on the SAME ZONE (*.workers.dev) is rejected by the edge (error 1042). So the
   * public-URL + service-token fallback below only works cross-zone/cross-account.
   * When present, the binding is used INSTEAD of GATEWAY_BASE_URL/GW_ACCESS_*.
   * Mirrors bot-fleet's GATEWAY binding (apps/bot-fleet/src/platform/gateway/
   * gateway-client.ts).
   */
  GATEWAY?: Fetcher;
  /**
   * FALLBACK gateway discovery (GET /gateways) + provision-time gatewayId
   * validation: GATEWAY_BASE_URL + the GW Access service token. Used only when
   * the GATEWAY binding is absent (cross-zone/cross-account setups). Unset base
   * URL AND no binding => discovery disabled (any gatewayId accepted).
   */
  GATEWAY_BASE_URL?: string;
  /** GW Access service-token creds (SECRETS via `wrangler secret put`). */
  GW_ACCESS_CLIENT_ID?: string;
  GW_ACCESS_CLIENT_SECRET?: string;

  /**
   * Internal service binding to bot-fleet (script "bot-fleet"). Same rationale as
   * GATEWAY above — a same-zone Worker->Worker fetch needs a binding (error 1042
   * otherwise). Binding-ONLY (no BASE_URL/token fallback): it carries the bot
   * lifecycle control calls (POST /bots/:id/start, /reconfigure, /stop, GET
   * /bots/:id/stats — see HttpBotRuntime). The persona catalog is NO LONGER read
   * through here — FM reads it straight from HYPERDRIVE below.
   */
  BOT_FLEET?: Fetcher;

  /**
   * Hyperdrive -> Supabase (session pooler, caching OFF); SAME shared config id as
   * bot-fleet. FM reads the persona catalog (GET /personas -> UI picker) DIRECTLY
   * via listPersonaNames (platform/hyperdrive/persona-repo.ts), instead of proxying
   * bot-fleet's /personas. bot-fleet still owns getPersonaByName for reply
   * hydration; this binding only backs the name list for the picker.
   */
  HYPERDRIVE: Hyperdrive;
}

/** Per-request context values (Hono `c.get` / `c.set`). */
export interface AppVariables {
  /** Correlation id for this request (== correlation.request_id). Kept for back-compat. */
  requestId: string;
  /** Full correlation context (request_id + optional cf_ray). */
  correlation: CorrelationContext;
  /** Request-scoped structured logger (svc + correlation pre-bound). */
  log: StageLogger;
}

/** Hono generic env for this worker (Bindings + Variables). */
export interface AppEnv {
  Bindings: FleetEnv;
  Variables: AppVariables;
}
