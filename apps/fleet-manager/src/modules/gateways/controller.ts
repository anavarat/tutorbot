import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { BotsDao, type BotRow } from "../../platform/persistence/bots-dao";
import { GatewaysDao } from "../../platform/persistence/gateways-dao";
import { HttpGatewayLifecycle } from "../../platform/gateway/gateway-lifecycle";
import { fail } from "../../lib/http";
import { GatewayService } from "./service";
import { provisionGatewaySchema } from "./schema";

/** Build the service from request bindings (cheap per-request wiring / DI). */
function service(c: Context<AppEnv>): GatewayService {
  return new GatewayService(
    new GatewaysDao(c.env.DB),
    new BotsDao(c.env.DB),
    new HttpGatewayLifecycle(c.env.GATEWAY),
  );
}

/** One bot's cold-start recovery credential (the minimal set the container needs
 *  to rebuild its MTProto socket with no re-auth). Field names MATCH the GW's
 *  `RecoverableSession`/`buildConnectBody` so the container maps 1:1. */
export interface RecoveryBot {
  botId: string;
  apiId: number;
  sessionCredential: string;
}

/**
 * Pure shaper for the recovery roster. Keeps only bots that carry a
 * usable credential quad (apiId + sessionCredential); a running bot missing either
 * has nothing to recover, so it is skipped rather than emitted with holes. The
 * `api_hash` is DELIBERATELY NOT emitted — reconnect never reads it (the container
 * uses a placeholder; see gateway session-store), so it stays out of the payload.
 * Pure + exported so the secret-shaping is unit-tested without D1/Hono.
 */
export function toRecoveryBots(rows: BotRow[]): RecoveryBot[] {
  const out: RecoveryBot[] = [];
  for (const r of rows) {
    if (r.api_id == null || r.session_credential == null) continue;
    out.push({ botId: r.bot_id, apiId: r.api_id, sessionCredential: r.session_credential });
  }
  return out;
}

/**
 * GET /gateways/:id/roster — a gateway container's cold-start recovery roster
 * (Pull model). For every RUNNING bot pinned to this gateway it
 * returns the minimal credential the container needs to REBUILD its socket without
 * re-auth: { botId, apiId, sessionCredential }. FM D1 is the authoritative source;
 * the GW's DO storage is only a warm-cache fallback for when FM is unreachable.
 *
 * ⚠ SECURITY: sessionCredential is FULL ACCOUNT ACCESS. This endpoint is for the
 * INTERNAL FLEET_MANAGER service binding only (GW onStart pull) and rides the same
 * Access-gated-public + binding-bypass posture as /connection/connect (creds are
 * already D1-readable to every FM-reacher; the GW already holds its own bots' creds
 * in memory — no widened surface). The response body is NEVER logged (the access
 * log records path + status only); this handler logs the COUNT, never the creds.
 */
export async function roster(c: Context<AppEnv>) {
  const gatewayId = c.req.param("id")!; // route pattern "/:id/roster" guarantees presence
  const rows = await new BotsDao(c.env.DB).listRunningByGateway(gatewayId);
  const bots = toRecoveryBots(rows);
  c.get("log").info("gateway.roster", "served cold-start recovery roster", { gatewayId, count: bots.length });
  return c.json({ ok: true, gatewayId, bots }, 200);
}

/** POST /gateways */
export async function provision(c: Context<AppEnv>) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return fail(c, 400, "invalid JSON body");
  }

  const parsed = provisionGatewaySchema.safeParse(raw);
  if (!parsed.success) {
    return fail(c, 400, "invalid body", { issues: parsed.error.issues });
  }

  const result = await service(c).provision(parsed.data);
  c.get("log").info("gateway.provision", "gateway provisioned", {
    gatewayId: result.gateway.gateway_id,
  });
  return c.json({ ok: true, gateway: result.gateway }, 200);
}

/** GET /gateways */
export async function list(c: Context<AppEnv>) {
  const result = await service(c).list();
  return c.json({ ok: true, ...result }, 200);
}

/** GET /gateways/:id */
export async function getOne(c: Context<AppEnv>) {
  const gatewayId = c.req.param("id")!; // route pattern "/:id" guarantees presence
  const result = await service(c).getOne(gatewayId);
  if (result.kind === "not_found") return fail(c, 404, "not found", { gatewayId: result.gatewayId });
  return c.json({ ok: true, gateway: result.gateway }, 200);
}

/** DELETE /gateways/:id (?force=1 to bypass the pinned-bots guard) */
export async function reap(c: Context<AppEnv>) {
  const gatewayId = c.req.param("id")!; // route pattern "/:id" guarantees presence
  const force = c.req.query("force") === "1";
  const result = await service(c).reap(gatewayId, force);
  switch (result.kind) {
    case "not_found":
      return fail(c, 404, "not found", { gatewayId: result.gatewayId });
    case "has_bots":
      c.get("log").warn("gateway.reap", "reap blocked: bots still pinned", {
        gatewayId: result.gatewayId,
        count: result.count,
      });
      return fail(
        c,
        409,
        `gateway '${result.gatewayId}' still has ${result.count} bot(s) pinned; reassign them or retry with ?force=1`,
        { count: result.count },
      );
    case "ok":
      c.get("log").info("gateway.reap", "gateway reaped", {
        gatewayId: result.gatewayId,
        containerStopped: result.containerStopped,
        stopError: result.stopError,
      });
      return c.json(
        {
          ok: true,
          gatewayId: result.gatewayId,
          deleted: true,
          containerStopped: result.containerStopped,
          stopError: result.stopError,
        },
        200,
      );
  }
}
