import { CONTAINER_REQUEST_FAILED, DB_DSN_FIELD, INVALID_REQUEST } from "@tutorbot/shared";
import { Hono } from "hono";

import { createCorrelationContext, createStageLogger } from "@tutorbot/shared/observability";
import type { WorkerBindings } from "../system/contracts.js";
import { invalidateDsn } from "../db/dsn.js";
import { forwardToGateway, resolveDbDsn, stopGatewayContainer } from "./gateway.js";
import { getRoster } from "./roster.js";

/**
 * Gateway discovery + control plane. Every route keys off a gatewayId, which the
 * Worker uses verbatim as the GatewayContainer DO instance name (routing by
 * name). Inbound/outbound message routes are added in later phases.
 */
export function createGatewayRouter() {
  const router = new Hono<{ Bindings: WorkerBindings }>();

  // Discovery: the active gateway roster. FleetManager (D1) OWNS this roster; the
  // Worker fetches it via the FLEET_MANAGER service binding (cached in-isolate,
  // see roster.ts) and materialises a container per id lazily (getContainer).
  // This is NOT a Cloudflare API — no API lists running containers.
  router.get("/gateways", async (c) =>
    c.json({ ok: true, component: "worker", gateways: [...(await getRoster(c.env))] }),
  );

  // Liveness probe for one named gateway container. Proves name -> container
  // routing end-to-end and gives FleetManager a per-gateway health check.
  router.get("/gateways/:gatewayId/health", (c) =>
    forwardToGateway(c.env, c.req.param("gatewayId"), "/health", { method: "GET" }),
  );

  // Connection health probe: the live botId set on this gateway's
  // container, for FleetManager's connection-reconcile sweep. Passes THROUGH the
  // GatewayContainer DO untouched (its fetch only wraps connect/disconnect) to the
  // container's GET /connections. No secret -> plain forward.
  router.get("/gateways/:gatewayId/connections", (c) =>
    forwardToGateway(c.env, c.req.param("gatewayId"), "/connections", { method: "GET" }),
  );

  // Stop one gateway's CONTAINER instance by name. Called by FleetManager on
  // reap so a reaped gateway stops running/billing immediately instead of
  // lingering until sleepAfter (5h). Deliberately does NOT roster-check — the
  // gateway may already be gone from the roster by the time this runs. The
  // caller treats this as best-effort (a failure only means the container
  // lingers until its idle window).
  router.post("/gateways/:gatewayId/stop", async (c) => {
    const gatewayId = c.req.param("gatewayId");
    const log = createStageLogger({ context: { svc: "gw-worker", gatewayId } });
    try {
      await stopGatewayContainer(c.env, gatewayId);
      log.info("gateway.stop", "stopped gateway container", { gatewayId });
      return c.json({ ok: true, component: "worker", gatewayId, stopped: true }, 200);
    } catch (err) {
      log.error("gateway.stop", "failed to stop gateway container", { error: String(err) });
      return c.json(
        {
          ok: false,
          component: "worker",
          error: { code: CONTAINER_REQUEST_FAILED, message: String(err) },
        },
        502,
      );
    }
  });

  // Resolve a botId -> its home gatewayId. FleetManager (D1) owns the bot->gateway
  // mapping, so callers ask here instead of picking a gateway by hand. This calls
  // FleetManager over an INTERNAL service binding
  // (env.FLEET_MANAGER), which bypasses Access + CORS — no service token needed.
  //   200 { ok: true,  botId, gatewayId }            -> resolved
  //   200 { ok: false, reason: "not_provisioned" }   -> bot has no gateway yet (normal)
  //   400 INVALID_REQUEST                             -> missing botId
  //   502 CONTAINER_REQUEST_FAILED                    -> FleetManager missing/unreachable/5xx
  router.get("/bot-gateway", async (c) => {
    const correlation = createCorrelationContext(c.req.raw);
    const botId = c.req.query("botId") ?? "";
    const context: Record<string, unknown> = { svc: "gw-worker" };
    if (botId) context.botId = botId;
    const log = createStageLogger({ context, correlation });

    if (!botId) {
      log.warn("resolve.fail", "request missing botId", { reason: "missing_botid" });
      return c.json(
        {
          ok: false,
          component: "worker",
          error: { code: INVALID_REQUEST, message: "Query must include botId: /bot-gateway?botId=bot-1" },
        },
        400,
      );
    }

    const fleetManager = c.env.FLEET_MANAGER;
    if (!fleetManager) {
      log.error("resolve.fail", "FLEET_MANAGER service binding is not configured", { reason: "no_binding" });
      return c.json(
        {
          ok: false,
          component: "worker",
          error: { code: CONTAINER_REQUEST_FAILED, message: "FLEET_MANAGER service binding is not configured" },
        },
        502,
      );
    }

    let res: Response;
    try {
      // Host is irrelevant for a service binding (never hits DNS); the path is
      // what FleetManager routes on. FleetManager: GET /bots/:id.
      res = await fleetManager.fetch(
        new Request(`https://fleet-manager/bots/${encodeURIComponent(botId)}`, { method: "GET" }),
      );
    } catch (err) {
      log.error("resolve.fail", "FleetManager unreachable", { reason: "fm_unreachable", error: String(err) });
      return c.json(
        {
          ok: false,
          component: "worker",
          error: { code: CONTAINER_REQUEST_FAILED, message: `FleetManager unreachable: ${String(err)}` },
        },
        502,
      );
    }

    // 404 = bot is not provisioned. That is a normal state (not an error), so the
    // UI can prompt the operator to provision it — surface it as ok:false + reason.
    if (res.status === 404) {
      log.info("resolve.miss", "bot has no gateway yet", { reason: "not_provisioned" });
      return c.json({ ok: false, component: "worker", reason: "not_provisioned", botId }, 200);
    }
    if (!res.ok) {
      log.error("resolve.fail", "FleetManager returned error status", { reason: "fm_status", status: res.status });
      return c.json(
        {
          ok: false,
          component: "worker",
          error: { code: CONTAINER_REQUEST_FAILED, message: `FleetManager returned ${res.status}` },
        },
        502,
      );
    }

    const data = (await res.json().catch(() => null)) as { bot?: { gateway_id?: unknown } } | null;
    const gatewayId = typeof data?.bot?.gateway_id === "string" ? data.bot.gateway_id : "";
    if (!gatewayId) {
      log.error("resolve.fail", "FleetManager response missing bot.gateway_id", { reason: "no_gateway_id" });
      return c.json(
        {
          ok: false,
          component: "worker",
          error: { code: CONTAINER_REQUEST_FAILED, message: "FleetManager response missing bot.gateway_id" },
        },
        502,
      );
    }

    log.info("resolve.ok", "resolved bot to gateway", { gatewayId });
    return c.json({ ok: true, component: "worker", botId, gatewayId }, 200);
  });

  // Outbound: a bot's generated reply. Routed by body.gatewayId to the container
  // that "owns" the conversation, which buffers it for delivery.
  router.post("/outbound", async (c) => {
    const correlation = createCorrelationContext(c.req.raw);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      createStageLogger({ context: { svc: "gw-worker" }, correlation }).warn(
        "forward.outbound",
        "rejected outbound with non-JSON body",
        { reason: "bad_json" },
      );
      return c.json(
        {
          ok: false,
          component: "worker",
          error: { code: INVALID_REQUEST, message: "Body must be JSON: { gatewayId, botId, content, idempotencyKey }" },
        },
        400,
      );
    }

    const gatewayId =
      typeof (body as Record<string, unknown>).gatewayId === "string"
        ? ((body as Record<string, unknown>).gatewayId as string)
        : "";
    const botId =
      typeof (body as Record<string, unknown>).botId === "string"
        ? ((body as Record<string, unknown>).botId as string)
        : "";
    const context: Record<string, unknown> = { svc: "gw-worker" };
    if (botId) context.botId = botId;
    if (gatewayId) context.gatewayId = gatewayId;
    const log = createStageLogger({ context, correlation });

    // Resolve the Postgres DSN and inject it into the BODY (Option B, body
    // transport): /deliver is a DB route (the container stamps the reply row). The
    // DSN must NOT ride a header/URL — invocation logs capture those in plaintext.
    const { dsn, error: dsnError } = await resolveDbDsn(c.env);
    if (dsnError) {
      log.warn("dsn.resolve", "could not resolve Postgres DSN from Secrets Store; forwarding without it", {
        error: dsnError,
      });
    }

    // Propagate x-request-id downstream so the Worker + container log lines
    // for one reply share a single id.
    try {
      const res = await forwardToGateway(c.env, gatewayId, "/deliver", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": correlation.request_id },
        body: JSON.stringify({ ...(body as Record<string, unknown>), [DB_DSN_FIELD]: dsn }),
      });
      // A 5xx may be a rotated-DSN auth failure -> invalidate the cache so the next
      // attempt re-fetches from the Secrets Store and the container rebuilds its pool.
      if (res.status >= 500) invalidateDsn();
      log.info("forward.outbound", "routed outbound to gateway", { status: res.status });
      return res;
    } catch (err) {
      log.error("forward.fail", "outbound forward to gateway failed", {
        direction: "outbound",
        error: String(err),
      });
      throw err;
    }
  });

  // Connection connect: bind a bot's pre-minted StringSession to a live Telegram
  // client INSIDE the target container (routed by body.gatewayId). Like the DB
  // routes this resolves the Postgres DSN and injects it into the BODY — not because
  // connect writes to Postgres, but because the container CACHES the DSN per bot
  // so a later inbound socket event (no HTTP request) can persist. The DSN and the
  // session credential are BOTH secrets: they ride the body (never a header/URL,
  // which invocation logs capture) and are never logged here.
  router.post("/connection/connect", async (c) => {
    const correlation = createCorrelationContext(c.req.raw);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      createStageLogger({ context: { svc: "gw-worker" }, correlation }).warn(
        "forward.connection_connect",
        "rejected connection connect with non-JSON body",
        { reason: "bad_json" },
      );
      return c.json(
        {
          ok: false,
          component: "worker",
          error: { code: INVALID_REQUEST, message: "Body must be JSON: { gatewayId, botId, sessionCredential, apiId?, apiHash? }" },
        },
        400,
      );
    }

    const gatewayId =
      typeof (body as Record<string, unknown>).gatewayId === "string"
        ? ((body as Record<string, unknown>).gatewayId as string)
        : "";
    const botId =
      typeof (body as Record<string, unknown>).botId === "string"
        ? ((body as Record<string, unknown>).botId as string)
        : "";
    const context: Record<string, unknown> = { svc: "gw-worker" };
    if (botId) context.botId = botId;
    if (gatewayId) context.gatewayId = gatewayId;
    const log = createStageLogger({ context, correlation });

    // Resolve + inject the Postgres DSN (body transport, cache at connect).
    const { dsn, error: dsnError } = await resolveDbDsn(c.env);
    if (dsnError) {
      log.warn("dsn.resolve", "could not resolve Postgres DSN from Secrets Store; forwarding without it", {
        error: dsnError,
      });
    }

    try {
      const res = await forwardToGateway(c.env, gatewayId, "/connection/connect", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": correlation.request_id },
        body: JSON.stringify({ ...(body as Record<string, unknown>), [DB_DSN_FIELD]: dsn }),
      });
      if (res.status >= 500) invalidateDsn();
      log.info("forward.connection_connect", "routed connection connect to gateway", { status: res.status });
      return res;
    } catch (err) {
      log.error("forward.fail", "connection connect forward to gateway failed", {
        direction: "connection_connect",
        error: String(err),
      });
      throw err;
    }
  });

  // Connection disconnect: tear a bot's live socket down on the named gateway
  // (reassignment DETACH). Routed by body.gatewayId; the request
  // passes THROUGH the GatewayContainer DO, whose fetch() deletes the bot's stored
  // credential before forwarding so a later cold-start can't resurrect the socket.
  // No DSN (disconnect creates no state). No secret in the body -> plain forward.
  router.post("/connection/disconnect", async (c) => {
    const correlation = createCorrelationContext(c.req.raw);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json(
        {
          ok: false,
          component: "worker",
          error: { code: INVALID_REQUEST, message: "Body must be JSON: { gatewayId, botId }" },
        },
        400,
      );
    }

    const gatewayId =
      typeof (body as Record<string, unknown>).gatewayId === "string"
        ? ((body as Record<string, unknown>).gatewayId as string)
        : "";
    const botId =
      typeof (body as Record<string, unknown>).botId === "string"
        ? ((body as Record<string, unknown>).botId as string)
        : "";
    const context: Record<string, unknown> = { svc: "gw-worker" };
    if (botId) context.botId = botId;
    if (gatewayId) context.gatewayId = gatewayId;
    const log = createStageLogger({ context, correlation });

    try {
      const res = await forwardToGateway(c.env, gatewayId, "/connection/disconnect", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": correlation.request_id },
        body: JSON.stringify({ botId }),
      });
      log.info("forward.connection_disconnect", "routed connection disconnect to gateway", {
        status: res.status,
      });
      return res;
    } catch (err) {
      log.error("forward.fail", "connection disconnect forward to gateway failed", {
        direction: "connection_disconnect",
        error: String(err),
      });
      throw err;
    }
  });

  return router;
}
