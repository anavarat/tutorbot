import { Hono } from "hono";

import type { ReconfigureOpts, StartOpts } from "@tutorbot/shared/rpc";
import type { BotFleetEnv } from "./types";

/**
 * Control plane over HTTP (bot lifecycle). fleet-manager drives these via its
 * BOT_FLEET service binding — the SAME transport it uses for the gateway and the
 * persona catalog, so every fleet-manager -> service call is now plain REST over a
 * binding (no cross-script Durable Object RPC stub).
 *
 * bot-fleet OWNS the BotFleetDO class, so it resolves the per-bot DO by name here
 * (`getByName(botId)`) and invokes its native method. That DO RPC is now an
 * INTERNAL, same-worker call — fleet-manager no longer holds a cross-script DO
 * namespace at all.
 *
 *   POST /bots/:botId/start        { gatewayId, personaName?, runMinutes?, force? }
 *   POST /bots/:botId/reconfigure  { gatewayId }
 *   POST /bots/:botId/stop
 *   GET  /bots/:botId/stats
 *
 * A method's BUSINESS outcome (e.g. reconfigure ok:false "not running") is a 200 —
 * it is a valid result, not a transport error. Only a thrown DO error is a 500, so
 * the caller (HttpBotRuntime) can treat non-2xx as an infra failure.
 */
export function createControlRouter() {
  const router = new Hono<{ Bindings: BotFleetEnv }>();

  router.post("/bots/:botId/start", async (c) => {
    const botId = c.req.param("botId");
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<StartOpts>;
    if (typeof body.gatewayId !== "string" || !body.gatewayId) {
      return c.json({ ok: false, error: "gatewayId is required" }, 400);
    }
    try {
      const result = await c.env.BOT_FLEET_DO.getByName(botId).start({
        botId,
        gatewayId: body.gatewayId,
        personaName: body.personaName,
        runMinutes: body.runMinutes,
        force: body.force,
      });
      return c.json(result, 200);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  router.post("/bots/:botId/reconfigure", async (c) => {
    const botId = c.req.param("botId");
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<ReconfigureOpts>;
    if (typeof body.gatewayId !== "string" || !body.gatewayId) {
      return c.json({ ok: false, error: "gatewayId is required" }, 400);
    }
    try {
      const result = await c.env.BOT_FLEET_DO.getByName(botId).reconfigure({ gatewayId: body.gatewayId });
      return c.json(result, 200);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  router.post("/bots/:botId/stop", async (c) => {
    const botId = c.req.param("botId");
    try {
      const result = await c.env.BOT_FLEET_DO.getByName(botId).stop();
      return c.json(result, 200);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  router.get("/bots/:botId/stats", async (c) => {
    const botId = c.req.param("botId");
    try {
      const result = await c.env.BOT_FLEET_DO.getByName(botId).stats();
      return c.json(result, 200);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  return router;
}
