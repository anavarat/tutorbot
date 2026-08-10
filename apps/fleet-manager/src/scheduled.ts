/**
 * FM cron `scheduled` handler. Runs two idempotent reconcile
 * sweeps on every tick:
 *   1. stuck-saga reconcile — resume/roll back reassignment sagas that crashed
 *      between steps (reassign_state stuck past the timeout).
 *   2. connection health sweep — reconnect bots D1 says are RUNNING but whose
 *      gateway container reports no live socket (silent dead socket).
 *
 * Both are best-effort and self-contained: a failure in one is logged and does not
 * block the other. The handler builds its own BotService from `env` (no Hono
 * Context on the cron path) using the SAME DI wiring as bots/controller.ts.
 */
import { createStageLogger } from "@tutorbot/shared/observability";

import type { FleetEnv } from "./types";
import { BotsDao } from "./platform/persistence/bots-dao";
import { GatewaysDao } from "./platform/persistence/gateways-dao";
import { HttpBotRuntime } from "./platform/botfleet/bot-runtime";
import { D1GatewayDirectory } from "./platform/gateway/gateway-directory";
import { HttpGatewayConnections } from "./platform/gateway/gateway-connection";
import { BotService } from "./modules/bots/service";

/**
 * A reassignment saga older than this is "stuck". A healthy reassign
 * completes in SECONDS, so this only needs to exceed the max legitimate move
 * duration — 2 min leaves wide margin so a live saga is never mistaken for stuck
 * and double-driven, while still healing a genuinely crashed one within a tick.
 */
const SAGA_TIMEOUT_MS = 120_000;

function buildBotService(env: FleetEnv): BotService {
  return new BotService(
    new BotsDao(env.DB),
    new HttpBotRuntime(env.BOT_FLEET),
    new D1GatewayDirectory(new GatewaysDao(env.DB)),
    new HttpGatewayConnections(env.GATEWAY),
    new GatewaysDao(env.DB),
  );
}

export async function runScheduled(
  _event: ScheduledController,
  env: FleetEnv,
): Promise<void> {
  const log = createStageLogger({ context: { svc: "fleet-manager" } });
  const svc = buildBotService(env);

  try {
    const sagas = await svc.reconcileStuckSagas(SAGA_TIMEOUT_MS);
    if (sagas.swept > 0) {
      log.info("reconcile.sagas", "resumed stuck reassignment sagas", {
        swept: sagas.swept,
        results: sagas.results,
      });
    }
  } catch (e) {
    log.error("reconcile.sagas", "stuck-saga reconcile failed", { error: (e as Error).message });
  }

  try {
    const conns = await svc.reconcileConnections();
    if (conns.results.length > 0) {
      const healed = conns.results.filter((r) => r.kind === "reconnected").length;
      log.info("reconcile.connections", "connection health sweep", {
        gateways: conns.gateways,
        running: conns.running,
        healed,
        results: conns.results,
      });
    }
  } catch (e) {
    log.error("reconcile.connections", "connection reconcile failed", { error: (e as Error).message });
  }
}
