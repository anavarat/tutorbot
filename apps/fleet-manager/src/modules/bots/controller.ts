import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { BotsDao } from "../../platform/persistence/bots-dao";
import { GatewaysDao } from "../../platform/persistence/gateways-dao";
import { HttpBotRuntime } from "../../platform/botfleet/bot-runtime";
import { D1GatewayDirectory } from "../../platform/gateway/gateway-directory";
import { HttpGatewayConnections } from "../../platform/gateway/gateway-connection";
import { fail } from "../../lib/http";
import { BotService } from "./service";
import { provisionSchema, updateBotSchema } from "./schema";

/** Build the service from request bindings (cheap per-request wiring / DI). */
function service(c: Context<AppEnv>): BotService {
  return new BotService(
    new BotsDao(c.env.DB),
    new HttpBotRuntime(c.env.BOT_FLEET),
    new D1GatewayDirectory(new GatewaysDao(c.env.DB)),
    new HttpGatewayConnections(c.env.GATEWAY),
    new GatewaysDao(c.env.DB),
  );
}

/** POST /bots */
export async function provision(c: Context<AppEnv>) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return fail(c, 400, "invalid JSON body");
  }

  const parsed = provisionSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(c, 400, "invalid body", { issues: parsed.error.issues });
  }

  const log = c.get("log");
  const result = await service(c).provision(parsed.data);
  switch (result.kind) {
    case "ok":
      log.info("provision.pin", "bot provisioned and started", {
        botId: result.bot?.bot_id,
        gatewayId: result.bot?.gateway_id ?? parsed.data.gatewayId,
        runMinutes: parsed.data.runMinutes,
        force: parsed.data.force ?? false,
        // identity.id/username only — never the session credential.
        identityId: result.identity.id,
      });
      return c.json({ ok: true, bot: result.bot, start: result.start, identity: result.identity }, 200);
    case "start_failed":
      log.warn("provision.start", "bot start failed", {
        botId: result.bot?.bot_id,
        gatewayId: parsed.data.gatewayId,
      });
      return c.json({ ok: false, bot: result.bot, start: result.start }, 409);
    case "unknown_gateway":
      log.warn("provision.pin", "unknown gatewayId rejected", {
        gatewayId: result.gatewayId,
        known: result.known,
      });
      return fail(c, 400, `unknown gatewayId '${result.gatewayId}'`, { known: result.known });
    case "connection_failed":
      // Container could not bind the StringSession (bad/expired session, wrong
      // api creds, or GW/container unreachable). The bot row is left 'failed'.
      log.error("provision.connection", result.error, { botId: result.botId });
      return fail(c, 502, `connection connect failed: ${result.error}`, { botId: result.botId });
    case "do_error":
      log.error("provision.start", result.error, { botId: result.botId });
      return fail(c, 502, result.error, { botId: result.botId });
  }
}

/** PATCH /bots/:id — update the bot->gateway / persona mapping. */
export async function updateConfig(c: Context<AppEnv>) {
  const botId = c.req.param("id")!; // route pattern "/:id" guarantees presence
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return fail(c, 400, "invalid JSON body");
  }

  const parsed = updateBotSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(c, 400, "invalid body", { issues: parsed.error.issues });
  }

  const log = c.get("log");
  const result = await service(c).updateConfig(botId, parsed.data);
  switch (result.kind) {
    case "ok":
      log.info("provision.pin", "bot config updated", {
        botId: result.bot?.bot_id,
        gatewayId: result.bot?.gateway_id,
        restarted: result.restarted,
        reconfigured: result.reconfigured ?? false,
      });
      return c.json(
        {
          ok: true,
          bot: result.bot,
          restarted: result.restarted,
          reconfigured: result.reconfigured ?? false,
          start: result.start,
        },
        200,
      );
    case "start_failed":
      log.warn("provision.start", "bot restart after config update failed", {
        botId: result.bot?.bot_id,
      });
      return c.json({ ok: false, bot: result.bot, start: result.start }, 409);
    case "not_found":
      return fail(c, 404, "not found", { botId: result.botId });
    case "unknown_gateway":
      log.warn("provision.pin", "unknown gatewayId rejected", {
        gatewayId: result.gatewayId,
        known: result.known,
      });
      return fail(c, 400, `unknown gatewayId '${result.gatewayId}'`, { known: result.known });
    case "connection_failed":
      // Reassignment saga: the target gateway could not accept the connection, so
      // the bot was ROLLED BACK to its old gateway (still running there — the move
      // is a no-op, not a failure of the bot). 502 = the target GW leg failed.
      log.error("provision.connection", result.error, { botId: result.botId });
      return fail(c, 502, `reassignment attach failed (bot stays on old gateway): ${result.error}`, {
        botId: result.botId,
      });
    case "do_error":
      log.error("provision.start", result.error, { botId: result.botId });
      return fail(c, 502, result.error, { botId: result.botId });
  }
}

/** GET /bots (?live=1) */
export async function list(c: Context<AppEnv>) {
  const live = c.req.query("live") === "1";
  return c.json(await service(c).list(live), 200);
}

/** GET /bots/:id */
export async function getOne(c: Context<AppEnv>) {
  const botId = c.req.param("id")!; // route pattern "/:id" guarantees presence
  const result = await service(c).getOne(botId);
  if (result.kind === "not_found") return fail(c, 404, "not found", { botId: result.botId });
  return c.json({ bot: result.bot, stats: result.stats }, 200);
}

/** POST /bots/:id/stop */
export async function stop(c: Context<AppEnv>) {
  const botId = c.req.param("id")!; // route pattern "/:id" guarantees presence
  const result = await service(c).stop(botId);
  if (result.kind === "not_found") return fail(c, 404, "not found", { botId: result.botId });
  c.get("log").info("provision.stop", "bot stopped", { botId: result.botId });
  return c.json({ ok: true, botId: result.botId, stop: result.stop }, 200);
}

/** POST /bots/:id/restart — force a fresh run of a RUNNING bot (current mapping). */
export async function restart(c: Context<AppEnv>) {
  const botId = c.req.param("id")!; // route pattern "/:id" guarantees presence
  const log = c.get("log");
  const result = await service(c).restart(botId);
  switch (result.kind) {
    case "ok":
      log.info("provision.start", "bot restarted", {
        botId,
        gatewayId: result.bot?.gateway_id,
      });
      return c.json({ ok: true, bot: result.bot, restarted: true, start: result.start }, 200);
    case "start_failed":
      log.warn("provision.start", "bot restart failed", { botId });
      return c.json({ ok: false, bot: result.bot, start: result.start }, 409);
    case "not_running":
      return fail(c, 409, "bot is not running (restart only recycles a running bot)", { botId });
    case "not_found":
      return fail(c, 404, "not found", { botId });
    case "do_error":
      log.error("provision.start", result.error, { botId });
      return fail(c, 502, result.error, { botId });
  }
}

/** DELETE /bots/:id */
export async function remove(c: Context<AppEnv>) {
  const botId = c.req.param("id")!; // route pattern "/:id" guarantees presence
  const result = await service(c).remove(botId);
  if (result.kind === "not_found") return fail(c, 404, "not found", { botId: result.botId });
  c.get("log").info("provision.remove", "bot removed from registry", { botId: result.botId });
  return c.json({ ok: true, botId: result.botId, deleted: true }, 200);
}
